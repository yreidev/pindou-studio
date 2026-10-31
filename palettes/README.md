# 拼豆色卡

顾客「做图纸」工具用的色卡（方案见 `docs/plan-bead-maker.md`）。小程序和网页后台直接引用 `palettes.json`；
后端 `pindou-backend/internal/palettes/palettes.json` 是逐字节相同的副本（go:embed 出不了模块目录），测试比对，改这里要一起改。

每套色卡：`id`（编号，存进顾客的图纸里）、`name`、`brand`（牌子，选色卡时按它分组）、`region`（`cn` 国内、`intl` 国外）、`colors`（色号和颜色值，按色卡顺序）。

- 国内 6 套取自 [HansBug/pindou-color-data](https://github.com/HansBug/pindou-color-data) 2026-05-19 版（MIT，许可证原文见 `LICENSE-pindou-color-data`），
  只留色号和颜色值：MARD 221（`mard-221-github`）、MARD 291（`mard-291-github`）、漫漫 278、盼盼 289、咪小窝 290、COCO 291。
  上游标为「未能确认色号」的颜色没收（盼盼、咪小窝各 4 个），所以这两套比名字上的少 4 个。
- 国外 11 套取自 [maxcleme/beadcolors](https://github.com/maxcleme/beadcolors) 提交 `0d724fc`（2026-08-17，MIT，许可证原文见 `LICENSE-beadcolors`）的 `raw/` 目录，
  只留色号（转成大写）和颜色值：Perler 标准、Perler 迷你、Hama 中号（`hama.csv`）、Hama 迷你、Artkal A、C、M、R、S、Nabbi、Yant。
  不收 Hama Maxi、Perler Caps 和钻石画那套。Artkal M 上游说明写 174 色，数据文件里是 220 个，以数据文件为准。
- 颜色值是屏幕上的近似，和实物、不同批次的豆子都有偏差。
- 色号和颜色值写进顾客存下的图纸里，已发布的色号不要改名、删掉；要换数据就加一套新的 `id`。
