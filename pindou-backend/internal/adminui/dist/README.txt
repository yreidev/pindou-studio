网页后台的构建产物在这里由 make admin-embed 从 pindou-admin/dist 复制进来，不入库。
本文件让 go:embed 在没有构建产物时也能编译（开发、测试时访问页面会提示「网页后台未构建」）。
