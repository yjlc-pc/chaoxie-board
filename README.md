# 抄写大屏

拍一页纸 → 本地识别成 `.tex` → 投到大屏上，按笔画节奏一行一行往下滚。

识别全程在浏览器里跑（GLM-OCR + WebGPU），图片不上传。没有构建步骤，没有后端。

## 运行

```bash
./start.sh          # 默认 8770，端口占用会自动换一个
./start.sh 9000
```

也可以直接部署到 GitHub Pages（见下），或任意静态服务器。**`file://` 打不开**：项目用原生 ES module，浏览器会拦。

浏览器要求：Chromium 系（Chrome / Edge），需要 **WebGPU**。没有 WebGPU 会自动退到 WASM，速度会慢到分钟级。

## 怎么用

1. 拖图片进来 / `Ctrl+V` 粘贴截图 / 点「选择图片」/ 点「拍照」。
2. 第一次点「识别并上屏」会下载 GLM-OCR（约 621 MB，缓存进浏览器）。
3. 识别完直接进大屏：整段可见，按「笔画数 × 每笔秒数」自动往下滚。
4. 底部控制条：上一行 / 暂停 / 下一行 / 慢一点 / 快一点 / 退出。鼠标静止 5 秒淡出。

## 排版规则

- **一行 = 一个句子**。切分先按 `。！？；…`，句子在被逼到最小字号还放不下时，按 `，、：` 二级切分，再不行硬折行。
- **公式独占整行**，KaTeX 渲染，按「每式秒数」单独计时。
- **字号二分**：约束是「一行装下一个句子（真实 DOM 溢出测量）」且「至少 3 行完整可见」，取满足条件的最大字号。
- **推进**：没有当前字高亮。每行时长 = 该行汉字笔画总数 × 每笔秒数，到点平滑上滚一行。

## 目录

```
chaoxie-board/
├── index.html              输入页 + 大屏 + 三个 dialog
├── manifest.webmanifest    PWA + file_handlers（系统里双击图片可选用本应用）
├── sw.js                   应用外壳离线缓存
├── start.sh                本地开发服务
├── css/                    tokens（墨金主题）/ base / setup / board
├── data/strokes.json       9574 个汉字的笔画数（81 KB，构建期压平）
├── src/
│   ├── core/               config / settings / storage / split / layout / strokes / format
│   ├── latex/              parse（.tex → 单元）/ render（KaTeX 懒加载）
│   ├── ocr/                worker（GLM-OCR 推理）/ client（预处理、进度、降档）
│   ├── board/              Board（唯一计时器）
│   ├── ui/                 setup / boardView / toast
│   ├── voice/              语音（第二阶段，当前是骨架）
│   └── main.js             唯一装配入口
├── vendor/
│   ├── transformers/       transformers.js 4.3.1 + ORT WebGPU wasm（本地托管）
│   └── katex/              KaTeX 0.16.47 dist
└── .github/workflows/      Pages 自动发布
```

## 模型与依赖

| 用途 | 来源 | 体积 |
|---|---|---|
| OCR | `onnx-community/GLM-OCR-ONNX`（MIT，0.9B） | q4f16 约 621 MB |
| 权重下载 | `https://hf-mirror.com`（`env.remoteHost`） | 首次识别时下载，进 Cache Storage |
| 运行时 | transformers.js 4.3.1 + onnxruntime-web 1.31（已 vendor 进仓库） | 42 MB |
| 公式 | KaTeX 0.16.47（已 vendor） | 1.5 MB |
| 字体 | 系统字体（楷体优先），不拉 webfont | 0 |

量化档默认 `q4f16`；如果设备没有 `shader-f16` 或初始化失败，自动降到 `q4` 重试。

### 为什么 vendor 目录里有被改过的文件

`transformers.web.min.js` 原本按打包工具的方式 `import "onnxruntime-web/webgpu"` 和 `"onnxruntime-common"`，浏览器里解析不了。这两处已改成相对路径：

- `onnxruntime-web/webgpu` → `./ort.webgpu.mjs`（ORT 1.31 WebGPU bundle）
- `onnxruntime-common` → `./ort-common/index.js`（ONNX Runtime 公共 API 的 ESM 构建）

所以本项目零构建、零 CDN 也能跑。升级 transformers.js 时需要重复这两处替换。

### 开发自检

```bash
# 一个带调试端口的浏览器
chromium --headless=new --remote-debugging-port=9222 --user-data-dir=.chrome-profile about:blank &
node tools/cdp-check.mjs 'http://127.0.0.1:8770/?sample=1'     # 打印 booted/行数/字号/控制台错误
node tools/cdp-check.mjs 'http://127.0.0.1:8770/tools/modtest.html'  # 验证 vendor 依赖能在 Worker 里解析
```


## 已知限制

- **多栏排版会被按视觉横排拼错顺序**（GLM-OCR 的已知问题），识别结果只能靠重新拍或语音改。
- **手写体、竖排**识别质量没有保证。
- 4K 大屏 + 核显上，单页识别在十几秒量级，首次还要加下载时间。
- 语音（Whisper + 指令解析）尚未接入，`src/voice/voice.js` 目前是接口骨架。

## 部署到 GitHub Pages

1. 推到 `main` 分支，仓库 Settings → Pages → Source 选 **GitHub Actions**。
2. `.github/workflows/pages.yml` 会直接发布仓库根目录（无构建步骤）。
3. 访问 `https://<user>.github.io/chaoxie-board/`，地址栏装成应用后即可关联图片文件。

`vendor/` 里的 wasm 有 42 MB，确保用普通 git 提交（不要 LFS 之外的压缩工具处理）。

## 手测清单

- [ ] 拖一张 A4 印刷中文图片 → 识别 → 大屏能滚动
- [ ] `Ctrl+V` 粘贴截图能进预览
- [ ] 手机竖拍照片（EXIF 旋转）方向正确
- [ ] HEIC 文件给出明确提示，不白屏
- [ ] 4K 下字号二分后至少 3 行完整可见，无横向裁切
- [ ] 长句（>40 字无逗号）不溢出屏幕
- [ ] 公式独占整行，KaTeX 正常渲染
- [ ] 首次下载有进度百分比，可取消
- [ ] 断网后重新打开，已缓存的模型仍能识别
- [ ] 底部控制条 5 秒后淡出，触摸后恢复
- [ ] 装成 PWA 后，系统里双击 `.jpg` 能选「抄写大屏」
