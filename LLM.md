## KDocs 金山文档批量下载脚本说明（LLM 使用文档）

本文档用于帮助大语言模型（以及人类维护者）快速理解 `script.js` 的整体设计、依赖、关键接口以及注意事项，便于在此基础上继续开发或重构。

---

### 一、脚本概览

- **脚本类型**: Tampermonkey / 油猴用户脚本
- **作用页面**: `https://www.kdocs.cn/*`（排除 `https://www.kdocs.cn/l/*`，通过 `@noframes` 禁止 iframe 注入）
- **主要功能**:
  - 在页面显示一个**可拖拽的悬浮球**，点击后从右侧滑出操作面板。
  - 自动拉取当前空间（个人 / 团队 / 企业版 / 手机端）、当前文件夹及其所有子文件夹的文件树。
  - 在面板中提供树形多选、全选/反选、失败标记等。
  - 文件列表加载过程中，实时展示「已扫描文件夹数 / 发现文件数」。
  - 支持四种下载方式（由用户在弹出的方式选择器中显式选择）：
    1. **单文件另存为**：`window.showSaveFilePicker`，适用于仅选中 1 个文件。
    2. **批量保存到文件夹**：`window.showDirectoryPicker`，并发边下载边写入本地目录。
    3. **浏览器逐个下载**：逐个触发 `<a download>` 元素，强制顺序执行（`concurrency = 1`），前置 `alert()` 提示用户允许多文件下载权限。
    4. **ZIP 打包下载**：使用 JSZip 将所有选中文件打包为 ZIP 后下载。ZIP 内部路径会**剥除公共根目录**（去除 `根目录` 前缀或共享的单一顶级目录）。
  - 底部带有**可折叠下载日志面板**，集中展示所有进度与异常信息，新条目自动滚到底部。

---

### 二、技术架构

脚本采用**单文件模块化 IIFE** 结构，UI 通过 **Web Component + Shadow DOM** 封装，注册为自定义元素 `<kdocs-downloader>`。

```
┌─────────────────────────────────────────┐
│  Tampermonkey header (@noframes)        │
├─────────────────────────────────────────┤
│  CONFIG — 常量 & API 端点模板           │
├─────────────────────────────────────────┤
│  Utils — formatMtime, formatFileSize,   │
│          fetchJSON, mapFileNode,        │
│          formatZipTimestamp, clamp...   │
├─────────────────────────────────────────┤
│  CacheService — localStorage 持久缓存   │
│  (get, set, clear, purgeExpired)        │
│  TTL 自动过期 + 启动时清理过期条目        │
├─────────────────────────────────────────┤
│  DataService — 所有 fetch 封装（带缓存） │
│  (fetchTeamInfo, fetchFileMetadata,     │
│   fetchFolderContents, processFolderStack,│
│   fetchDownloadUrl ← 不缓存)            │
├─────────────────────────────────────────┤
│  parsePageUrl() / initRootAndFetch()    │
├─────────────────────────────────────────┤
│  TreeModel — 树节点纯函数操作           │
│  (setSelection, updateCheckboxStates,   │
│   isAllSelected, getSelectedFiles)      │
├─────────────────────────────────────────┤
│  DownloadEngine — 四种下载策略          │
│  (downloadSingleFile,                   │
│   downloadToDirectory,                  │
│   downloadViaBrowser,                   │
│   downloadAndZip)                       │
├─────────────────────────────────────────┤
│  STYLES — CSS 字符串 (亮色主题，        │
│  注入 Shadow DOM)                       │
├─────────────────────────────────────────┤
│  KDocsUI (extends HTMLElement)          │
│  ├─ constructor → 状态初始化            │
│  ├─ connectedCallback → Shadow DOM 挂载 │
│  ├─ _createFAB → 悬浮球 (拖拽/吸附/半隐)│
│  ├─ _initDrag → Pointer + click 事件   │
│  ├─ _initFabAutoHide → 自动半隐藏      │
│  ├─ _showFabCloseDialog → 自定义确认框  │
│  ├─ _showFirstUseTooltip → 初次提示     │
│  ├─ _createBackdrop → 半透明遮罩        │
│  ├─ _createPanel → 滑出面板、日志区     │
│  ├─ _initResize → 拖拽调整面板宽度      │
│  ├─ _fetchAndRender → 数据加载 + 计数   │
│  ├─ _renderTree → 文件树渲染            │
│  ├─ _showDownloadModeSelector → 下载方式│
│  └─ _handleDownload → 调度具体下载策略  │
├─────────────────────────────────────────┤
│  INIT:                                  │
│  1. window.__KDOCS_DL_INIT__ 防重复     │
│  2. CacheService.purgeExpired()         │
│  3. customElements.define(TAG, KDocsUI) │
│  4. document.body.appendChild(TAG)      │
└─────────────────────────────────────────┘
```

---

### 三、主要依赖与外部 API

- **外部库**
  - `JSZip`（通过 `@require https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js` 引入）

- **浏览器 API**
  - **File System Access API**
    - `window.showSaveFilePicker`：单文件「另存为」。
    - `window.showDirectoryPicker`：选择本地目标目录。
    - `FileSystemDirectoryHandle.getDirectoryHandle/getFileHandle`：创建子目录/文件。
    - `createWritable() → write(chunk) → close()`：流式写入磁盘。
  - `fetch` / `ReadableStream` / `response.body.getReader()`：流式读取。
  - **Web Component**: `class KDocsUI extends HTMLElement`，通过 `customElements.define('kdocs-downloader', KDocsUI)` 注册。
  - **Shadow DOM**: `attachShadow({ mode: 'open' })` 封装所有 UI 元素。
  - **Pointer Events**: `pointerdown/pointermove/pointerup` 实现悬浮球拖拽。
  - **click 事件**: 悬浮球点击打开面板（兼容桌面和移动端）。
  - **localStorage**:
    - `kdocs-downloader:cache:*`：API 结果缓存（CacheService）。
    - `kdocs-downloader:settings`：保存悬浮球位置 `fabPos` 与下载并发数 `concurrency` 等用户偏好。
    - `kdocs-downloader:ui:tooltip-shown`：标记初次使用提示已展示过。
    - `kdocs-downloader:ui:close-confirmed`：标记关闭确认框已确认过（后续直接隐藏）。

- **KDocs / WPS Drive 接口**（定义在 `API` 对象中）
  - `API.metadata(fileId)` → 文件元数据
  - `API.teamInfo(teamId)` → 团队信息
  - `API.rootFiles()` → 个人根目录文件列表
  - `API.folderFiles(groupid, parentid)` → 文件夹内容
  - `API.download(groupid, id)` → 文件下载 URL

> 所有请求均使用 `credentials: 'include'`，依赖当前登录态 Cookie。

---

### 四、缓存策略

- **存储介质**：`localStorage`，key 前缀 `kdocs-downloader:cache:`
- **TTL**：`CONFIG.CACHE_TTL`（默认 5 分钟）
- **缓存的 API**：`fetchTeamInfo`、`fetchFileMetadata`、`fetchRootContents`、`fetchFolderContents`
- **不缓存的 API**：`fetchDownloadUrl`（下载链接有时效性，缓存会导致链接过期）
- **命中计数器**：
  - `CacheService.hits`：每轮加载前 `resetHits()`，加载过程中若有命中则递增。
  - `KDocsUI._lastLoadUsedCache`：一轮加载结束后记录是否曾命中过缓存，仅在**复用上一轮数据再次打开面板**时用来决定是否展示缓存提示条。
- **自动清理**：`CacheService.purgeExpired()` 在脚本启动时执行，删除所有已过期的条目和损坏的 JSON
- **手动刷新**：点击「🔄 刷新」按钮或缓存提示条中的「立即刷新」链接 → 调用 `CacheService.clear()` 清空所有 `kdocs-downloader:cache:*` 条目

---

### 五、UI 说明

#### 悬浮球 (FAB)

- **外观**：36×36 圆形（`CONFIG.BALL_SIZE`），蓝色渐变背景（`#2069E0 → #4A90F0`），带白色文件图标 SVG
- **交互**：
  - **拖拽**：Pointer Events 实现移动，移动距离 < `CONFIG.DRAG_THRESHOLD` (5px) 视为点击。
  - **点击**：通过 `click` 事件（非 `pointerup`）处理面板打开，兼容桌面和移动端。
  - **吸附**：松手后自动吸附到最近的左/右边缘（0px 偏移），带弹簧动画。
  - **半隐藏**：吸附到边缘后 3 秒无操作，则根据左右侧只露出半个圆（CSS `transform`），hover 时恢复。
  - **移动端恢复**：移动端无 hover，点击半隐藏的 FAB 先恢复完整显示（重启 3 秒计时器），再次点击才打开面板。
  - **面板联动**：面板打开时 FAB 隐藏（`display: none !important`），面板关闭时恢复显示并重启半隐藏计时。
  - **关闭按钮**：hover 显示右上角 `×`，点击弹出 Shadow DOM 内自定义确认框（仅首次，之后直接隐藏），确认后隐藏整个元素，刷新页面后重新显示。
  - **初次使用提示**：首次渲染时显示气泡 tooltip（「点击展开下载面板」），5 秒后或首次点击后消失，通过 `localStorage` 标记不再显示。
  - **持久化**：位置存入 `kdocs-settings.fabPos`，窗口 `resize` 时自动 clamp。

#### 面板 (Panel)

- **布局**：右侧滑入 440px 宽面板，亮色主题（白色背景 `rgba(255,255,255,0.96)`），可全屏。
- **全屏切换**：Header 右侧 `⛶` 按钮，点击切换全屏/还原（图标 `⛶` ↔ `❐`）。
- **可调宽度**：面板左侧 6px 拖拽句柄，向左拖 = 变宽，最小 320px，拖至边缘自动全屏。
- **Header**：标题 + 全屏按钮 + 关闭按钮。
- **Toolbar**：
  - 并发数输入：值范围 1–20，对应下载并发，保存在 `kdocs-settings.concurrency` 中。
  - 全选按钮：基于 `TreeModel.isAllSelected` 实现全选/全不选。
  - 刷新按钮：清空缓存并重新拉取文件树。
  - 下载按钮：弹出**下载方式选择器**。
- **缓存提示条**：在最近一次加载「曾命中过缓存」（`CacheService.hits > 0`）时立即显示，或复用旧数据时显示。
- **进度区域**：主进度条 + ZIP 进度条。
- **文件树**：可滚动区域，自定义三态 checkbox，hover 文件名显示完整名称。
- **下载日志区**：底部固定可折叠区域，新条目自动滚到底部，最大高度 40% 面板。

#### 移动端适配 (@media max-width: 640px)

- 面板自动 100vw 全宽，隐藏拖拽句柄
- 隐藏文件大小/修改时间等 `tree-meta` 信息
- tree-row 增加上下 padding 便于触摸操作

#### Shadow DOM 封装

所有 UI 元素在 `<kdocs-downloader>` 自定义元素的 Shadow DOM 内：

```css
:host {
    --accent: #2069E0;       /* KDocs 品牌蓝 */
    --bg-panel: rgba(255, 255, 255, 0.96);
    --text-primary: #1a1a2e;
    --border: rgba(0, 0, 0, 0.08);
    /* ... */
}
```

---

### 六、URL 场景与空间识别逻辑

`parsePageUrl()` 解析当前 URL，`initRootAndFetch()` 据此分发数据加载逻辑。

#### PC 端

| `type` | URL 模式 | 说明 |
|---|---|---|
| `personal_root` | 不含特定路径段 | 个人空间根目录 |
| `personal_folder` | `/mine/{fileId}` | 个人子文件夹 |
| `team_root` | `/team/{teamId}[?folderid=...]` | 团队根目录 |
| `team_subfolder` | `/team/{teamId}/{folderId}` | 团队子文件夹 |
| `team_root` | `/space/{orgid}/{groupid}` | 企业版个人空间根目录（orgid 忽略） |
| `team_subfolder` | `/space/{orgid}/{groupid}/{fid}` | 企业版个人空间子文件夹 |
| `team_root` | `/ent/{orgid}/{groupid}` | 企业版共享空间根目录（orgid 忽略） |
| `team_subfolder` | `/ent/{orgid}/{groupid}/{fid}` | 企业版共享空间子文件夹 |

#### 手机端 (/m/)

| `type` | URL 模式 | 说明 |
|---|---|---|
| `personal_folder` | `/m/folder/{groupid}/{folderid}` | 手机端个人文件夹（groupId 直接从 URL 取） |
| `team_subfolder` | `/m/folder/{tid}?gid={gid}&fid={fid}` | 手机端团队子文件夹 |
| `team_root` | `/m/folder/{groupid}` | 手机端团队/共享根目录 |
| `team_subfolder` | `/m/{groupid}/{folderId}` | 手机端子文件夹 |

> 企业版 `/space/` 和 `/ent/` URL 的 groupid 映射为 `teamId` 使用，API 调用方式与团队空间一致。

---

### 七、数据结构与文件树

树节点结构：

```js
{
  id: string,
  groupid: string,
  parentid?: string,
  name: string,
  type: 'folder' | string,
  size?: number,
  mtime: string | null,       // Utils.formatMtime() 输出
  linkUrl?: string,            // 非空时显示 🔗 链接
  children: Node[],
  checked: boolean | 'indeterminate'
}
```

- `type === 'folder'` 表示文件夹
- `checked` 支持三态：`true` / `false` / `'indeterminate'`
- `failedDownloads` 是 `Set<string>`，下载失败的 `file.id` 会被标红

---

### 八、下载逻辑与方式选择

脚本提供四种下载策略，由 `KDocsUI._handleDownload()` 协调，具体策略由用户在 UI 中选择（`_showDownloadModeSelector()`）：

1. **`DownloadEngine.downloadSingleFile(file, ui)`**
   - 适用场景：仅选中 1 个文件，且浏览器支持 `showSaveFilePicker`。
   - 行为：弹出系统「另存为」对话框，将流式响应写入一个文件句柄。

2. **`DownloadEngine.downloadToDirectory(files, concurrency, dirHandle, failedSet, ui)`**
   - 适用场景：多文件下载且浏览器支持 `showDirectoryPicker`。
   - 行为：用户选择目标目录后，按并发数获取下载链接并流式写入对应子目录/文件。

3. **`DownloadEngine.downloadViaBrowser(files, concurrency, ui)`**
   - 适用场景：用户选择「浏览器逐个下载」，或环境不支持 FS API。
   - 行为：**强制 `concurrency = 1`** 顺序下载，避免浏览器拦截。前置 `alert()` 提示用户允许多文件下载权限。

4. **`DownloadEngine.downloadAndZip(files, concurrency, failedSet, ui)`**
   - 适用场景：用户选择 ZIP，或 FS API 调用失败时的兜底策略。
   - 行为：先并发下载所有文件到内存，再用 JSZip 打包生成 ZIP Blob 并触发下载。
   - **ZIP 内部路径规则**：剥除公共根目录（若所有文件路径以 `'根目录'` 或同一顶级目录开头，则去掉该前缀）。
   - ZIP 文件名规则：`<base>_yyyy_MM_dd_HH_mm_ss.zip`。

所有策略接收一个 `ui` 对象 `{ showProgress, showFileStatus, showZipProgress, log }` 用于更新进度区域和底部日志区。

---

### 九、防重复初始化机制

脚本通过三层防护确保页面上只出现一个 `<kdocs-downloader>` 实例：

1. **`@noframes`**：Tampermonkey 头部声明，阻止脚本在 iframe 中执行。
2. **`window.__KDOCS_DL_INIT__`**：全局标志位，若已设置则 IIFE 立即 return。
3. **`customElements.get(TAG)`**：若自定义元素已注册则跳过 `define`。

---

### 十、关键行为总结

- **Web Component 封装**：所有 UI 挂载在 `<kdocs-downloader>` 的 Shadow DOM 内。
- **悬浮球行为**：Pointer Events 拖拽 + click 点击 + 边缘吸附 + 半隐藏 + 移动端恢复 + 自定义关闭确认框 + 初次使用提示 + 位置持久化。
- **亮色主题**：与 KDocs 页面整体风格一致的白色面板设计。
- **面板全屏 / 缩放**：全屏切换按钮 + 左边缘拖拽句柄 + 移动端自动全宽。
- **空间识别**：`parsePageUrl()` → 个人/团队/企业版/手机端共 12 种 URL 模式。
- **文件树构建**：`initRootAndFetch` → `processFolderStack` 深度遍历。
- **缓存策略**：localStorage 持久缓存 + TTL 自动过期 + 启动清理 + 手动刷新；缓存提示依赖 `_lastLoadUsedCache` 和 `CacheService.hits`。
- **下载方式选择**：统一的弹出式下载方式选择器，带「推荐」标记、禁用态提示和点击外部关闭逻辑。
- **下载日志**：进度与异常统一写入底部日志面板，自动滚到底部，并通过 `_friendlyErrorMessage()` 输出人类可读的错误信息。
- **选择逻辑**：`TreeModel` 对象提供纯函数操作。
- **错误处理**：失败文件记录到 `failedDownloads`，文件树 UI 标红显示，ZIP 与目录模式都会在日志区汇总失败信息。

后续修改入口：
- `CacheService` — 缓存策略（TTL、存储介质）。
- `parsePageUrl` / `initRootAndFetch` — URL 解析与根节点初始化。
- `DownloadEngine.*` — 各下载策略、ZIP 命名与路径规则、错误文案。
- `KDocsUI.connectedCallback` / `STYLES` — UI 布局与样式。
- `TreeModel.*` — 树节点操作与选中规则。
