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
│   ├── voice/              语音（Whisper tiny 转写 + 规则槽位/FunctionGemma 解析）
│   └── main.js             唯一装配入口
├── vendor/
│   ├── transformers/       transformers.js 4.3.1 + ORT WebGPU wasm（本地托管）
│   └── katex/              KaTeX 0.16.47 dist
└── .github/workflows/      Pages 自动发布
```

## 模型与依赖

| 用途 | 来源 | 体积 |
|---|---|---|
| OCR | `onnx-community/GLM-OCR-ONNX`（MIT，0.9B） | q4f16 约 650 MB |
| 权重下载 | **ModelScope 魔搭**（主）→ hf-mirror（备），见 `src/core/modelSource.js` | 首次识别时下载，进 Cache Storage |
| 运行时 | transformers.js 4.3.1 + onnxruntime-web 1.31（已 vendor 进仓库） | 42 MB |
| 公式 | KaTeX 0.16.47（已 vendor） | 1.5 MB |
| 字体 | 系统字体（楷体优先），不拉 webfont | 0 |

量化档默认 `q4f16`；如果设备没有 `shader-f16`、初始化失败或推理报错，自动降到 `q4` 重试一次。真正跑通的档位会记在 `localStorage`（`cb.ocr.dtype.v1`），下次直接从它开始。

> 实测这台核显（Intel gen-12lp）：`q4f16` **能建会话但一推理就崩**，报 `failed to call OrtRun() ... buffer_manager.cc:643`（GPU 缓冲区分配失败）。所以第一次识别会先失败一次再自动降 `q4`，之后就一直用 `q4`。

送进模型的图片最长边压到 **1400 px**（`CONFIG.OCR.MAX_EDGE`）。核显显存是共享内存，A4 原图直接喂进去会让 GPU 进程 OOM 崩掉（实测 1240×1754 就崩），1400 px 对印刷体识别质量没有可见损失。

### 权重来源为什么是 ModelScope

实测（2026-10）：`hf-mirror.com` 主站 TCP 连不上，只有 `cdn-lfs-*.hf-mirror.com` 子域能过；`huggingface.co` 的 DNS 被污染。`modelscope.cn` 三个仓库都有、CORS 是 `*`、LFS 走国内 CDN，所以主源是魔搭，hf-mirror 只做备用（`src/core/modelSource.js` 里按顺序尝试）。

魔搭与 HF 的仓库布局一致，只是默认分支叫 `master` 而不是 `main`，所以模板写死 `models/{model}/resolve/master/`。

### 为什么 vendor 目录里有被改过的文件

`transformers.web.min.js` 原本按打包工具的方式 `import "onnxruntime-web/webgpu"` 和 `"onnxruntime-common"`，浏览器里解析不了。这两处已改成相对路径：

- `onnxruntime-web/webgpu` → `./ort.webgpu.mjs`
- `onnxruntime-common` → `./ort-common/index.js`（ONNX Runtime 公共 API 的 ESM 构建）

`ort.webgpu.mjs` 里实际放的是 **`ort.webgpu.bundle.min.mjs`**（ORT 的 bundle 构建，自带内联 glue，里面有 `webgpuInit`）。这里踩过三个坑，改配置前先看：

1. **不要**把 `ort-wasm-simd-threaded.jsep.mjs` 放进同一目录。ORT 发现外部 glue 就改用它初始化，而外部 glue 只导出 `jsepInit`，bundle 的 EP 找 `webgpuInit` 就会报 `webgpuInit is not a function`。bundle 是自包含的，**只需要 `ort-wasm-simd-threaded.jsep.wasm`**。
2. **不要设 `env.backends.onnx.wasm.wasmPaths`**。同目录解析已经正确，设了反而会绕开内联 glue。
3. **Worker 里必须 `env.backends.onnx.wasm.numThreads = 1`**。否则 ORT 会去探测多线程 wasm（需要 `SharedArrayBuffer`／COOP+COEP），主线程会降级并打警告，Worker 里则**直接卡死且不报错**——这一条排查了很久。

另外 GLM-OCR 三个 ONNX 都是 `.onnx + .onnx_data` 拆分格式，调用 `from_pretrained` 时必须显式传 `use_external_data_format: true`，否则 sidecar 不会被下载/挂载，报 `Module.MountedFiles is not available`。

这些开关在 `src/ocr/worker.js` 和 `src/voice/worker.js` 里都已设好。升级 transformers.js 或 ORT 时需要重做上面几处替换，并重新确认 ORT 构建类型。

### 开发自检

```bash
# 一个带调试端口的浏览器（有显示器时才拿得到核显）
chromium --remote-debugging-port=9222 --user-data-dir=.chrome-profile about:blank &
node tools/cdp-check.mjs 'http://127.0.0.1:8770/?sample=1'     # 打印 booted/行数/字号/控制台错误
node tools/cdp-check.mjs 'http://127.0.0.1:8770/tools/modtest.html'  # 验证 vendor 依赖能在 Worker 里解析

# 端到端：选图 → 下载模型 → 识别 → 大屏（会真的下 650MB）
node tools/e2e-ocr.mjs testdata/page1.png 900
```


## 已知限制

- **多栏排版会被按视觉横排拼错顺序**（GLM-OCR 的已知问题），识别结果只能靠重新拍或语音改。
- **手写体、竖排**识别质量没有保证。
- 4K 大屏 + 核显上，单页识别在十几秒量级，首次还要加下载时间。
- 语音识别用 Whisper tiny，指令解析先走规则槽位（`src/voice/commands.js`），规则不中再叫 FunctionGemma 兜底；安静环境识别率明显更好。

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
- [ ] 按住右下角「按住说话」说「第三行第三个字改成明」→ 预览正确 → 确认后生效
- [ ] 说「暂停」「继续」「下一段」「快一点」能立刻响应，不需要确认
- [ ] 说一句听不懂的话 → 提示 + 示例 + 控件高亮
- [ ] 断网后按住说话仍能转写（离线包下过语音模型）
