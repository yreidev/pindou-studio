package app

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	catalogapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/catalog/application"
)

// writeCatalogItem 建商品资料（POST，网址里没有编号）或改一件（PATCH /catalog-items/{id}）。
//
// 建的时候名称、售价必填；改的时候只改带了的字段（至少一项），没带的保留原值——手机上给商品绑条码只带
// barcode，不会拿手里可能已经过时的名称、售价盖掉网页刚改的。条码去掉首尾空白，空串表示清除；
// 已登记在别的商品上回 409 barcode_taken，说清被哪件商品占了。
func (s *Server) writeCatalogItem(w http.ResponseWriter, r *http.Request) {
	u, err := s.userFor(r)
	if err != nil {
		s.writeError(w, r, 401, "unauthorized", err)
		return
	}
	if !hasRole(u, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	if idemKey(r) == "" {
		s.writeError(w, r, 400, "idempotency_required", errors.New("Idempotency-Key is required"))
		return
	}
	// omitempty：只带名称和售价的请求（加条码之前的客户端）摘要和以前一样，已记下的幂等键照样能重放。
	var input struct {
		Name           *string `json:"name,omitempty"`
		UnitPriceCents *int64  `json:"unitPriceCents,omitempty"`
		Barcode        *string `json:"barcode,omitempty"`
	}
	target := r.PathValue("id")
	creating := target == ""
	if err := decode(r, &input); err != nil {
		s.writeError(w, r, 400, "invalid_catalog_item", err)
		return
	}
	if creating && (input.Name == nil || input.UnitPriceCents == nil) {
		s.writeError(w, r, 400, "invalid_catalog_item", errors.New("商品名称和售价必填"))
		return
	}
	if input.Name == nil && input.UnitPriceCents == nil && input.Barcode == nil {
		s.writeError(w, r, 400, "invalid_catalog_item", errors.New("没有要修改的内容"))
		return
	}
	patch := catalogapp.Patch{Name: input.Name, UnitPriceCents: input.UnitPriceCents, Barcode: input.Barcode}
	// 新建的不用读库，先校验；修改的要和原值合起来才能校验，读出来再说
	if creating {
		if _, err := catalogapp.Apply(catalogapp.Item{}, patch); err != nil {
			s.writeCatalogError(w, r, err)
			return
		}
	}
	b, _ := json.Marshal(input)
	fingerprint := fmt.Sprintf("%x", sha256.Sum256(b))
	key := "catalog:" + u.ID + ":" + r.Method + ":" + target + ":" + idemKey(r)
	q := s.tx(r)
	if prior := q.idemGet(key); prior != nil {
		if prior.Fingerprint != fingerprint {
			s.writeError(w, r, 409, "idempotency_conflict", fmt.Errorf("request changed"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(prior.Status)
		_, _ = w.Write(prior.Body)
		return
	}
	status := 200
	var existing *catalogapp.Item
	current := catalogapp.Item{}
	if creating {
		status = 201
		current.ID = id()
	} else {
		if existing = q.catalogItem(target); existing == nil {
			s.writeError(w, r, 404, "not_found", errNotFound)
			return
		}
		current = *existing
	}
	item, err := catalogapp.Apply(current, patch)
	if err != nil {
		s.writeCatalogError(w, r, err)
		return
	}
	// 先查条码有没有被别的商品占用，再动工作集里的记录：查询前会先写回改过的记录，
	// 先改了就会在这里撞唯一索引，整个请求白白重来。
	if item.Barcode != "" && item.Barcode != current.Barcode {
		if other := q.catalogByBarcode(item.Barcode); other != nil && other.ID != item.ID {
			s.writeError(w, r, 409, "barcode_taken", fmt.Errorf("条码 %s 已经登记在「%s」上，一个条码只能对应一件商品", item.Barcode, catalogName(other)))
			return
		}
	}
	if creating {
		q.addCatalogItem(&item)
	} else {
		*existing = item
	}
	q.audit(u.ID, "catalog.updated", item.ID, barcodeChange(current.Barcode, item.Barcode), requestID(r))
	body, _ := json.Marshal(item)
	q.rememberIdem(key, idemResponse{Fingerprint: fingerprint, Status: status, ContentType: "application/json", Body: body})
	writeJSON(w, status, item)
}

func (s *Server) writeCatalogError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, catalogapp.ErrInvalidBarcode) {
		s.writeError(w, r, 400, "invalid_barcode", err)
		return
	}
	s.writeError(w, r, 400, "invalid_catalog_item", err)
}

// catalogName 是给员工看的商品名；只入过库、没建资料的商品写「未命名商品 · 编号前 8 位」。
func catalogName(item *catalogapp.Item) string {
	return productName(map[string]string{item.ID: item.Name}, item.ID)
}

// barcodeChange 是改条码时审计的原因（谁在什么时候把哪个条码绑到了这件商品上）；条码没变时为空。
func barcodeChange(before, after string) string {
	if before == after {
		return ""
	}
	show := func(code string) string {
		if code == "" {
			return "无"
		}
		return code
	}
	return "条码 " + show(before) + " → " + show(after)
}
