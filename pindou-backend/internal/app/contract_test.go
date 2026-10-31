package app

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pb33f/libopenapi"
	validator "github.com/pb33f/libopenapi-validator"
	"github.com/pb33f/libopenapi-validator/config"
	liberrors "github.com/pb33f/libopenapi-validator/errors"
	"github.com/pb33f/libopenapi-validator/helpers"
	"github.com/pb33f/libopenapi-validator/paths"
	"github.com/pb33f/libopenapi-validator/schema_validation"
	"github.com/pb33f/libopenapi/datamodel/high/base"
	v3 "github.com/pb33f/libopenapi/datamodel/high/v3"
	"github.com/pb33f/libopenapi/orderedmap"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
)

// 测试发出的每个接口请求，响应都按 docs/api.yaml 核对一遍（call、serve 里调用 checkContract）。
// 契约是小程序、网页后台和后端共用的唯一接口说明：后端的响应变了而契约没跟上，测试就失败。
//
//   - 成功（2xx、3xx）：方法与路径在契约里，状态码登记过，JSON 正文符合登记的 schema（含 uuid、date-time
//     这类 format），登记的必有响应头都在；正文里不能有契约没写的字段（JSON Schema 默认放行多余字段，
//     这里不放行，否则后端加了字段、生成的类型里却没有）；契约没写响应内容的，响应也不能带正文。
//   - 失败（4xx、5xx）：正文是统一的 Error，只有 code、message、requestId 三个键，requestId 与 X-Request-ID
//     头一致。不要求每个错误状态都逐一登记；登记了的照样按契约核对内容与响应头，说明里写明了错误码
//     （小写下划线的词，如 order_version_conflict）时，实际的 code 必须是其中之一、契约开头说的全局错误码，
//     或（400 时）这个接口的参数说明里写的错误码（如幂等键缺失的 idempotency_required）。
//   - 请求：后端照办了的（成功的）请求，路径与查询参数、请求头、JSON 正文也要合乎契约，正文同样不能有契约没写的
//     字段。否则后端认的字段或参数契约里没有，网页后台、小程序按生成的类型就发不出来；或者测试发的不是真客户端
//     会发的请求。被拒绝的请求不核对（测试本来就在故意发错的）。
//   - 不核对：接口以外的路径（网页后台页面、不带 /api/v2 的探针别名）和事件流（WebSocket 升级与 SSE）。
//     Excel 下载只核对状态码与 Content-Type（二进制正文没有可核对的 schema）。
//   - 完整跑完本包时（TestMain），契约里除事件流以外的每个接口都要有测试拿到过一次合乎契约的成功响应：
//     没测到的接口核对不到，契约会悄悄过时。
//
// 报出不符时先看是谁错了：契约没写全真实行为就改 docs/api.yaml（再 pnpm --dir pindou-admin api:types），
// 后端行为不对就改后端；不要为了让测试通过放宽这里的核对。

// contractFile 是契约文件，相对本包目录（go test 在包目录下运行）。
const contractFile = "../../../docs/api.yaml"

type apiContract struct {
	model      *v3.Document
	validator  validator.Validator
	schemas    schema_validation.SchemaValidator
	errorShape *base.Schema
	// globalCodes 是契约开头说「任何接口都可能回」的错误码。
	globalCodes []string
}

var (
	contractOnce   sync.Once
	loadedContract *apiContract
	contractError  error
)

// errorCode 认出说明里写的错误码：小写、至少一个下划线（字段名都是驼峰，不会混进来）。
var errorCode = regexp.MustCompile(`\b[a-z]+(?:_[a-z]+)+\b`)

func theContract() (*apiContract, error) {
	contractOnce.Do(func() {
		spec, err := os.ReadFile(contractFile)
		if err != nil {
			contractError = err
			return
		}
		doc, err := libopenapi.NewDocument(spec)
		if err != nil {
			contractError = err
			return
		}
		built, err := doc.BuildV3Model()
		if err != nil {
			contractError = err
			return
		}
		model := &built.Model
		c := &apiContract{
			model:       model,
			validator:   validator.NewValidatorFromV3Model(model, config.WithFormatAssertions()),
			schemas:     schema_validation.NewSchemaValidator(config.WithFormatAssertions()),
			globalCodes: errorCode.FindAllString(model.Info.Description, -1),
		}
		if model.Components != nil && model.Components.Schemas != nil {
			if proxy := model.Components.Schemas.GetOrZero("Error"); proxy != nil {
				c.errorShape = proxy.Schema()
			}
		}
		if c.errorShape == nil {
			contractError = fmt.Errorf("%s 里没有 components.schemas.Error", contractFile)
			return
		}
		loadedContract = c
	})
	return loadedContract, contractError
}

// exercised 记下这次测试里拿到过合乎契约的成功响应的接口（"GET /sales-orders/{salesOrderId}"）。
var exercised sync.Map

func TestMain(m *testing.M) {
	code := m.Run()
	if code == 0 && fullRun() {
		if missing := unexercised(); len(missing) > 0 {
			fmt.Fprintf(os.Stderr, "\n契约 docs/api.yaml 里这些接口没有任何测试拿到过成功响应，响应核对覆盖不到它们：\n  %s\n用 call 给每个补一个能成功的请求（可加在 contract_test.go 的 TestRarelyReadEndpointsMatchTheContract）。\n\n",
				strings.Join(missing, "\n  "))
			code = 1
		}
	}
	os.Exit(code)
}

// fullRun 是完整跑了本包的全部测试：没用 -run、-skip 挑选，不是 -short，没跳过数据库测试。
func fullRun() bool {
	for _, name := range []string{"test.run", "test.skip"} {
		if f := flag.Lookup(name); f != nil && f.Value.String() != "" {
			return false
		}
	}
	return !testing.Short() && os.Getenv("PINDOU_SKIP_DATABASE_TESTS") != "1"
}

// unexercised 是契约里（事件流除外）没有测试拿到过成功响应的接口。
func unexercised() []string {
	c, err := theContract()
	if err != nil {
		return []string{err.Error()}
	}
	var missing []string
	for path, item := range c.model.Paths.PathItems.FromOldest() {
		if path == "/event-streams" {
			continue
		}
		for method := range item.GetOperations().KeysFromOldest() {
			where := strings.ToUpper(method) + " " + path
			if _, ok := exercised.Load(where); !ok {
				missing = append(missing, where)
			}
		}
	}
	return missing
}

// serve 把请求交给 h，按契约核对请求与响应后返回（直接构造请求的测试用它代替 h.ServeHTTP）。
func serve(t *testing.T, h http.Handler, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	// 处理器会读走正文，先留一份副本
	req := sentRequest{method: r.Method, target: r.URL.RequestURI(), header: r.Header.Clone()}
	if r.Body != nil {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("读请求正文：%v", err)
		}
		req.body = body
		r.Body = io.NopCloser(bytes.NewReader(body))
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	checkContract(t, req, w)
	return w
}

// sentRequest 是测试发出的一次请求。
type sentRequest struct {
	method, target string
	header         http.Header
	body           []byte
}

func (r sentRequest) build() *http.Request {
	request := httptest.NewRequest(r.method, r.target, bytes.NewReader(r.body))
	request.Header = r.header.Clone()
	return request
}

// checkContract 按契约核对一次接口调用，不符合的用 t.Errorf 报出来（不中止测试，一次跑完看到全部问题）。
func checkContract(t *testing.T, req sentRequest, w *httptest.ResponseRecorder) {
	t.Helper()
	c, err := theContract()
	if err != nil {
		// 不用 Fatalf：call 也会在测试另开的 goroutine 里调用
		t.Errorf("读取接口契约 %s：%v", contractFile, err)
		return
	}
	where, problems := c.check(req.method, req.target, w)
	if w.Code < 400 {
		problems = append(problems, c.checkRequest(req)...)
	}
	if len(problems) == 0 {
		if where != "" && w.Code < 400 {
			exercised.Store(where, true)
		}
		return
	}
	const shown = 8
	more := ""
	if len(problems) > shown {
		more = fmt.Sprintf("\n    ……另有 %d 条", len(problems)-shown)
		problems = problems[:shown]
	}
	t.Errorf("不符合契约 docs/api.yaml：%s → %d\n    %s%s\n    请求正文：%s\n    响应正文：%s",
		where, w.Code, strings.Join(problems, "\n    "), more, excerpt(req.body), excerpt(w.Body.Bytes()))
}

// check 核对一次响应：where 是「方法 + 契约里的路径」（契约里没有时是实际路径），problems 是不符合之处。
// 不核对的路径返回空。
func (c *apiContract) check(method, target string, w *httptest.ResponseRecorder) (where string, problems []string) {
	path, _, _ := strings.Cut(target, "?")
	if !strings.HasPrefix(path, "/api/v2/") || path == "/api/v2/event-streams" {
		return "", nil
	}
	request := httptest.NewRequest(method, target, nil)
	pathItem, _, template := paths.FindPath(request, c.model, nil)
	var operation *v3.Operation
	if pathItem != nil {
		operation = helpers.ExtractOperation(request, pathItem)
	}
	where = method + " " + path
	if operation != nil {
		where = method + " " + template
		// 路径级的参数也算这个接口的参数（错误码核对要看它们的说明）。
		operation = withPathParameters(operation, pathItem)
	}
	if w.Code < 400 {
		return where, c.checkSuccess(request, w, operation)
	}
	return where, c.checkError(request, w, operation)
}

// checkSuccess 核对成功响应：接口、状态码、正文与响应头都要在契约里。
func (c *apiContract) checkSuccess(request *http.Request, w *httptest.ResponseRecorder, operation *v3.Operation) []string {
	if operation == nil {
		return []string{"契约里没有这个接口（方法 + 路径）"}
	}
	documented := documentedResponse(operation, w.Code)
	if documented == nil {
		return []string{"契约没有登记这个状态码"}
	}
	problems := c.validate(request, w)
	if orderedmap.Len(documented.Content) == 0 {
		if w.Body.Len() > 0 {
			problems = append(problems, "契约没写响应内容，实际带了正文")
		}
		return problems
	}
	mediaType, ok := helpers.FindMediaType(documented.Content, w.Header().Get("Content-Type"))
	if !ok || mediaType.Schema == nil || !strings.Contains(w.Header().Get("Content-Type"), "json") {
		return problems
	}
	var body any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		return problems // 解不开的正文 validate 已经报了
	}
	var extra []string
	undeclared(mediaType.Schema.Schema(), body, "$", &extra)
	sort.Strings(extra)
	for _, field := range extra {
		problems = append(problems, field+"：契约里没有这个字段")
	}
	return problems
}

// checkRequest 核对后端照办了的请求：查询参数、请求头、JSON 正文合乎契约，正文没有契约没写的字段。
// 契约里没有的接口不在这里报（响应核对已经报了）。报告每条以「请求」开头，和响应的问题分开。
func (c *apiContract) checkRequest(req sentRequest) []string {
	path, _, _ := strings.Cut(req.target, "?")
	if !strings.HasPrefix(path, "/api/v2/") || path == "/api/v2/event-streams" {
		return nil
	}
	request := req.build()
	pathItem, _, _ := paths.FindPath(request, c.model, nil)
	if pathItem == nil {
		return nil
	}
	operation := helpers.ExtractOperation(request, pathItem)
	if operation == nil {
		return nil
	}
	var problems []string
	if _, errs := c.validator.ValidateHttpRequest(request); len(errs) > 0 {
		for _, p := range describe(errs) {
			problems = append(problems, "请求 "+p)
		}
	}
	if operation.RequestBody == nil {
		if len(bytes.TrimSpace(req.body)) > 0 {
			problems = append(problems, "请求：契约没写请求正文，实际发了")
		}
		return problems
	}
	mediaType, ok := helpers.FindMediaType(operation.RequestBody.Content, req.header.Get("Content-Type"))
	if !ok || mediaType.Schema == nil {
		return problems // 内容类型不对 ValidateHttpRequest 已经报了
	}
	var body any
	if err := json.Unmarshal(req.body, &body); err != nil {
		return problems
	}
	var extra []string
	undeclared(mediaType.Schema.Schema(), body, "$", &extra)
	sort.Strings(extra)
	for _, field := range extra {
		problems = append(problems, "请求 "+field+"：契约里没有这个字段")
	}
	return problems
}

// checkError 核对失败响应：统一的 Error 形状；契约登记了这个状态码时再按它核对内容和错误码。
func (c *apiContract) checkError(request *http.Request, w *httptest.ResponseRecorder, operation *v3.Operation) []string {
	var problems []string
	if mediaType, _, err := mime.ParseMediaType(w.Header().Get("Content-Type")); err != nil || mediaType != "application/json" {
		problems = append(problems, fmt.Sprintf("错误响应的 Content-Type 是 %q，应为 application/json", w.Header().Get("Content-Type")))
	}
	if ok, errs := c.schemas.ValidateSchemaBytesWithVersion(c.errorShape, w.Body.Bytes(), 3.1); !ok {
		problems = append(problems, describe(errs)...)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err == nil {
		for key := range body {
			if key != "code" && key != "message" && key != "requestId" {
				problems = append(problems, fmt.Sprintf("错误正文多了 %q（只有 code、message、requestId）", key))
			}
		}
		if rid, _ := body["requestId"].(string); rid == "" || rid != w.Header().Get("X-Request-ID") {
			problems = append(problems, fmt.Sprintf("requestId %q 与响应头 X-Request-ID %q 不一致", rid, w.Header().Get("X-Request-ID")))
		}
	}
	if operation == nil {
		return problems
	}
	documented := documentedResponse(operation, w.Code)
	if documented == nil {
		return problems
	}
	if orderedmap.Len(documented.Content) > 0 || orderedmap.Len(documented.Headers) > 0 {
		problems = append(problems, c.validate(request, w)...)
	}
	if codes := errorCode.FindAllString(documented.Description, -1); len(codes) > 0 {
		allowed := slices.Concat(codes, c.globalCodes)
		if w.Code == http.StatusBadRequest {
			for _, p := range operation.Parameters {
				allowed = append(allowed, errorCode.FindAllString(p.Description, -1)...)
			}
		}
		if code, _ := body["code"].(string); !slices.Contains(allowed, code) {
			problems = append(problems, fmt.Sprintf("错误码 %q 不在契约为 %d 写明的 %v 里", code, w.Code, codes))
		}
	}
	return problems
}

// withPathParameters 是带上路径级参数的 operation（只读副本）。
func withPathParameters(operation *v3.Operation, item *v3.PathItem) *v3.Operation {
	if len(item.Parameters) == 0 {
		return operation
	}
	copied := *operation
	copied.Parameters = slices.Concat(item.Parameters, operation.Parameters)
	return &copied
}

// validate 用 libopenapi-validator 核对状态码、Content-Type、正文 schema 和登记的响应头。
func (c *apiContract) validate(request *http.Request, w *httptest.ResponseRecorder) []string {
	response := w.Result()
	defer func() { _ = response.Body.Close() }()
	if _, errs := c.validator.ValidateHttpResponse(request, response); len(errs) > 0 {
		return describe(errs)
	}
	return nil
}

// documentedResponse 是契约为这个状态码登记的响应（含 2XX 这类范围），没有登记返回 nil。
func documentedResponse(operation *v3.Operation, status int) *v3.Response {
	if operation.Responses == nil {
		return nil
	}
	if codes := operation.Responses.Codes; codes != nil {
		for _, key := range []string{strconv.Itoa(status), fmt.Sprintf("%dXX", status/100)} {
			if r := codes.GetOrZero(key); r != nil {
				return r
			}
		}
	}
	return operation.Responses.Default
}

// undeclared 把 value 里契约没写的字段（JSONPath）记进 out。对象只认 properties（连同 allOf 各项的）；
// additionalProperties 给了 schema 的是以数据为键的映射（如按商品编号记件数），键不算字段，值照样往下查；
// 既没有 properties 也没有组合的对象（只写 type: object）不限内容，不查。anyOf/oneOf 取多余字段最少的一支。
func undeclared(schema *base.Schema, value any, path string, out *[]string) {
	if schema == nil {
		return
	}
	switch v := value.(type) {
	case []any:
		if schema.Items != nil && schema.Items.IsA() && schema.Items.A != nil {
			for i, item := range v {
				undeclared(schema.Items.A.Schema(), item, fmt.Sprintf("%s[%d]", path, i), out)
			}
		}
		for _, member := range schema.AllOf {
			undeclared(member.Schema(), value, path, out)
		}
	case map[string]any:
		if branches := append(slices.Clone(schema.AnyOf), schema.OneOf...); len(branches) > 0 {
			var best []string
			for i, branch := range branches {
				var found []string
				undeclared(merged(schema, branch.Schema()), value, path, &found)
				if i == 0 || len(found) < len(best) {
					best = found
				}
			}
			*out = append(*out, best...)
			return
		}
		properties, mapOf, open := objectShape(schema)
		if open {
			return
		}
		for key, field := range v {
			fieldPath := path + "." + key
			if property, ok := properties[key]; ok {
				undeclared(property, field, fieldPath, out)
			} else if mapOf != nil {
				undeclared(mapOf, field, fieldPath, out)
			} else {
				*out = append(*out, fieldPath)
			}
		}
	}
}

// objectShape 是对象的字段表（连同 allOf 各项的）、映射的值 schema；open 表示不限内容。
func objectShape(schema *base.Schema) (properties map[string]*base.Schema, mapOf *base.Schema, open bool) {
	properties = map[string]*base.Schema{}
	composed := false
	var collect func(s *base.Schema)
	collect = func(s *base.Schema) {
		if s == nil {
			return
		}
		for name, proxy := range s.Properties.FromOldest() {
			if _, seen := properties[name]; !seen {
				properties[name] = proxy.Schema()
			}
		}
		if ap := s.AdditionalProperties; ap != nil {
			if ap.IsA() && ap.A != nil {
				mapOf = ap.A.Schema()
			} else if ap.IsB() && ap.B {
				open = true
			}
		}
		for _, member := range s.AllOf {
			composed = true
			collect(member.Schema())
		}
	}
	collect(schema)
	if len(properties) == 0 && mapOf == nil && !composed {
		open = true
	}
	return properties, mapOf, open
}

// merged 是带着外层 properties、allOf 的某一支 anyOf/oneOf。
func merged(outer, branch *base.Schema) *base.Schema {
	return &base.Schema{
		Properties: outer.Properties,
		AllOf:      append(slices.Clone(outer.AllOf), base.CreateSchemaProxy(branch)),
	}
}

// describe 把校验器的报告压成一行一条：哪个字段、为什么。
func describe(errs []*liberrors.ValidationError) []string {
	var out []string
	for _, e := range errs {
		if len(e.SchemaValidationErrors) == 0 {
			out = append(out, strings.TrimSpace(e.Message+"："+e.Reason))
			continue
		}
		for _, f := range e.SchemaValidationErrors {
			field := f.FieldPath
			if field == "" {
				field = "/" + strings.Join(f.InstancePath, "/")
			}
			out = append(out, field+"："+f.Reason)
		}
	}
	return out
}

// excerpt 是报告里附带的正文开头。
func excerpt(body []byte) string {
	const limit = 300
	s := strings.TrimSpace(string(body))
	if len(s) > limit {
		s = strings.ToValidUTF8(s[:limit], "") + "……"
	}
	return s
}

// 别的测试没读到过成功响应的接口在这里各读一次，让它们也过一遍契约核对（TestMain 要求每个接口都测到）。
func TestRarelyReadEndpointsMatchTheContract(t *testing.T) {
	s := newTestServer(t)
	owner := register(t, s, "contract-owner", "老板")
	if err := s.BootstrapOwner(owner.User.ID); err != nil {
		t.Fatal(err)
	}
	customer := register(t, s, "contract-customer", "顾客")
	publishRule(t, s, owner.AccessToken, member.Rule{Kind: "package", Name: "1小时", AmountCents: 2990, DurationMinutes: 60, Overtime: "manual"})
	table := seedTable(t, s, "S1", "测试区", 1, 2, false)
	opened := call(t, s, http.MethodPost, "/api/v2/venue-sessions", owner.AccessToken, "",
		map[string]any{"serviceTableId": table.ID, "startedAt": s.now().Format(time.RFC3339), "timingMode": "timed", "durationMinutes": 60})
	if opened.Code != http.StatusCreated {
		t.Fatalf("open session: %d %s", opened.Code, opened.Body.String())
	}
	if w := call(t, s, http.MethodPost, "/api/v2/catalog-items", owner.AccessToken, id(), map[string]any{"name": "拼豆", "unitPriceCents": 500}); w.Code != http.StatusCreated {
		t.Fatalf("create catalog item: %d %s", w.Code, w.Body.String())
	}
	for _, c := range []struct{ path, bearer string }{
		{"/api/v2/healthz", ""},
		{"/api/v2/readyz", ""},
		{"/api/v2/floor-areas", owner.AccessToken},
		{"/api/v2/venue-sessions/" + decodeMap(t, opened)["id"].(string), owner.AccessToken},
		{"/api/v2/catalog-items", owner.AccessToken},
		{"/api/v2/loyalty/public", ""},
		{"/api/v2/loyalty/tables", customer.AccessToken},
	} {
		if w := call(t, s, http.MethodGet, c.path, c.bearer, "", nil); w.Code != http.StatusOK {
			t.Errorf("GET %s: %d %s", c.path, w.Code, w.Body.String())
		}
	}
}

// 核对本身要真能抓到不符：拿手工构造的响应逐条试（不连库）。
func TestContractCheckCatchesDrift(t *testing.T) {
	contract, err := theContract()
	if err != nil {
		t.Fatal(err)
	}
	reply := func(status int, body string, headers ...string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-ID", "req-1")
		for i := 0; i+1 < len(headers); i += 2 {
			w.Header().Set(headers[i], headers[i+1])
		}
		w.WriteHeader(status)
		_, _ = w.WriteString(body)
		return w
	}
	area := `{"id":"` + id() + `","name":"大厅"}`
	order := "/api/v2/sales-orders/" + id()
	rule, err := json.Marshal(member.Rule{ID: id(), Kind: "package", Name: "1小时", Enabled: true, AmountCents: 2990, DurationMinutes: 60, Overtime: "manual"})
	if err != nil {
		t.Fatal(err)
	}
	draft := id()
	settings := func(draftBody string) string {
		return `{"drafts":{"` + draft + `":` + draftBody + `},"rules":[],"publications":[],"version":"` + strings.Repeat("a", 64) + `"}`
	}
	errorBody := func(code string) string { return `{"code":"` + code + `","message":"x","requestId":"req-1"}` }
	for _, c := range []struct {
		name, method, target string
		w                    *httptest.ResponseRecorder
		want                 string // 报告里应有的一句；空串表示应当符合
	}{
		{"符合", "GET", "/api/v2/floor-areas", reply(200, "["+area+"]"), ""},
		{"多了字段", "GET", "/api/v2/floor-areas", reply(200, `[{"id":"`+id()+`","name":"大厅","gridX":1}]`), "$[0].gridX：契约里没有这个字段"},
		{"少了必有字段", "GET", "/api/v2/floor-areas", reply(200, `[{"id":"`+id()+`"}]`), "name"},
		{"格式不对", "GET", "/api/v2/floor-areas", reply(200, `[{"id":"abc","name":"大厅"}]`), "uuid"},
		{"契约里没有的接口", "GET", "/api/v2/nothing", reply(200, `{}`), "契约里没有这个接口"},
		{"没登记的状态码", "GET", "/api/v2/floor-areas", reply(201, "["+area+"]"), "契约没有登记这个状态码"},
		{"契约没写内容却带了正文", "DELETE", "/api/v2/auth/sessions/current", reply(204, `{"ok":true}`), "契约没写响应内容"},
		{"映射的键不算字段", "GET", "/api/v2/loyalty/settings", reply(200, settings(string(rule))), ""},
		{"映射的值照样核对", "GET", "/api/v2/loyalty/settings", reply(200, settings(strings.Replace(string(rule), "{", `{"extra":1,`, 1))), "$.drafts." + draft + ".extra：契约里没有这个字段"},
		{"anyOf 有一支对得上", "POST", "/api/v2/loyalty/actions", reply(200, `{"preview":"示例"}`), ""},
		{"anyOf 哪支都多字段", "POST", "/api/v2/loyalty/actions", reply(200, `{"preview":"示例","bogus":1}`), "$.bogus：契约里没有这个字段"},
		{"缺必有的响应头", "GET", "/api/v2/loyalty/members", reply(200, `[]`), "X-Total-Count"},
		{"必有的响应头都在", "GET", "/api/v2/loyalty/members", reply(200, `[]`, "X-Total-Count", "0", "X-Page", "1"), ""},
		{"写明的错误码", "POST", order + "/payments", reply(409, errorBody("order_version_conflict")), ""},
		{"全局错误码", "POST", order + "/payments", reply(503, errorBody("persistence_failed")), ""},
		{"幂等键参数写明的错误码", "POST", order + "/refunds", reply(400, errorBody("idempotency_required")), ""},
		{"没写明的错误码", "POST", order + "/payments", reply(409, errorBody("made_up_conflict")), `错误码 "made_up_conflict"`},
		{"没登记的错误状态只看形状", "GET", "/api/v2/floor-areas", reply(418, errorBody("teapot")), ""},
		{"错误少了 requestId", "GET", "/api/v2/nothing", reply(404, `{"code":"not_found","message":"x"}`), "requestId"},
		{"requestId 与响应头不一致", "GET", "/api/v2/nothing", reply(404, `{"code":"not_found","message":"x","requestId":"other"}`), "不一致"},
		{"错误正文多了键", "GET", "/api/v2/nothing", reply(404, `{"code":"not_found","message":"x","requestId":"req-1","detail":1}`), `多了 "detail"`},
		{"错误不是 JSON", "GET", "/api/v2/nothing", reply(404, "not found", "Content-Type", "text/plain"), "Content-Type"},
		{"网页后台页面不核对", "GET", "/orders", reply(200, "<html>", "Content-Type", "text/html"), ""},
		{"事件流不核对", "GET", "/api/v2/event-streams", reply(200, "data: {}", "Content-Type", "text/event-stream"), ""},
	} {
		_, problems := contract.check(c.method, c.target, c.w)
		joined := strings.Join(problems, "\n")
		switch {
		case c.want == "" && len(problems) > 0:
			t.Errorf("%s：不该报，却报了\n%s", c.name, joined)
		case c.want != "" && !strings.Contains(joined, c.want):
			t.Errorf("%s：报告里没有 %q\n%s", c.name, c.want, joined)
		}
	}
}

// 请求核对也要真能抓到不符（不连库）。
func TestContractRequestCheckCatchesDrift(t *testing.T) {
	contract, err := theContract()
	if err != nil {
		t.Fatal(err)
	}
	send := func(method, target, body string, headers ...string) sentRequest {
		header := http.Header{}
		header.Set("Authorization", "Bearer token")
		header.Set("Idempotency-Key", "key-1")
		if body != "" {
			header.Set("Content-Type", "application/json")
		}
		for i := 0; i+1 < len(headers); i += 2 {
			if headers[i+1] == "" {
				header.Del(headers[i])
			} else {
				header.Set(headers[i], headers[i+1])
			}
		}
		return sentRequest{method: method, target: target, header: header, body: []byte(body)}
	}
	session := func(fields string) string {
		return `{"serviceTableId":"` + id() + `","startedAt":"2026-10-05T19:00:00+08:00"` + fields + `}`
	}
	for _, c := range []struct {
		name string
		req  sentRequest
		want string // 报告里应有的一句；空串表示应当符合
	}{
		{"符合", send("POST", "/api/v2/catalog-items", `{"name":"拼豆","unitPriceCents":500}`), ""},
		{"多了字段", send("POST", "/api/v2/catalog-items", `{"name":"拼豆","unitPriceCents":500,"color":"红"}`), "请求 $.color：契约里没有这个字段"},
		{"缺必填的字段", send("POST", "/api/v2/venue-sessions", session(`,"durationMinutes":60`)), "timingMode"},
		{"空串不是合法的编号", send("POST", "/api/v2/venue-sessions", `{"serviceTableId":"","startedAt":"2026-10-05T19:00:00+08:00","timingMode":"timed","durationMinutes":60}`), "uuid"},
		{"缺必有的请求头", send("POST", "/api/v2/catalog-items", `{"name":"拼豆","unitPriceCents":500}`, "Idempotency-Key", ""), "Idempotency-Key"},
		{"没说正文是 JSON", send("POST", "/api/v2/catalog-items", `{"name":"拼豆","unitPriceCents":500}`, "Content-Type", ""), "content type"},
		{"契约没写正文却发了", send("POST", "/api/v2/system/data-exports", `{}`), "契约没写请求正文"},
		{"契约里没有的接口留给响应核对", send("GET", "/api/v2/nothing", ""), ""},
	} {
		joined := strings.Join(contract.checkRequest(c.req), "\n")
		switch {
		case c.want == "" && joined != "":
			t.Errorf("%s：不该报，却报了\n%s", c.name, joined)
		case c.want != "" && !strings.Contains(joined, c.want):
			t.Errorf("%s：报告里没有 %q\n%s", c.name, c.want, joined)
		}
	}
}
