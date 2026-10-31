# 抠图模型

`u2netp.br` 是 U²-Net 的小版本 u2netp（Xuebin Qin 等，2020，<https://github.com/xuebinqin/U-2-Net>，Apache-2.0，许可证原文见 `LICENSE-U2Net.md`），
权重取自 rembg 发布的 `u2netp.onnx`（<https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx>）。

改动：只留主输出、输入输出改名为 `image`/`mask`、常量折叠（onnxslim），Resize 改成固定倍数、MaxPool 关掉 ceil_mode（输入边长都是偶数，结果不变）；
除 5 层「大数相减」的卷积外，权重按输出通道压成 8 位，再按「骨架 + 8 位权重」打包、brotli 压缩（格式和解包见 `src/services/maker/cutout.ts` 的 `unpackModel`）。
解开后的 .onnx 的 sha256 是 `efc67c14d62c21e78cb14f483373bdcc8e7bc920ea70a422b09cca3ed1a03f69`。

构建时由 `config/index.ts` 的 copy 原样拷进做图纸分包 `pages/maker/model/`，只进小程序。
