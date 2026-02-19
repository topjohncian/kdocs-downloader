// ==UserScript==
// @name         [支持PC/移动端/企业版][KDocs] 金山文档批量下载小助手
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  支持个人/团队/企业版/手机端。提供批量下载、保留文件夹结构的并发下载、ZIP打包等多种方式。带有优雅的悬浮球和操作面板，自动适配移动端。
// @author       topjohncian
// @match        https://www.kdocs.cn/*
// @exclude      https://www.kdocs.cn/l/*
// @noframes
// @grant        none
// @require      https://unpkg.com/jszip@3.10.1/dist/jszip.min.js#sha256-rMfkFFWoB2W1/Zx+4bgHim0WC7vKRVrq6FTeZclH1Z4=
// @license      GPLv3
// @icon         https://www.google.com/s2/favicons?sz=64&domain=kdocs.cn
// @downloadURL  https://update.greasyfork.org/scripts/566729/%5B%E6%94%AF%E6%8C%81PC%E7%A7%BB%E5%8A%A8%E7%AB%AF%E4%BC%81%E4%B8%9A%E7%89%88%5D%5BKDocs%5D%20%E9%87%91%E5%B1%B1%E6%96%87%E6%A1%A3%E6%89%B9%E9%87%8F%E4%B8%8B%E8%BD%BD%E5%B0%8F%E5%8A%A9%E6%89%8B.user.js
// @updateURL    https://update.greasyfork.org/scripts/566729/%5B%E6%94%AF%E6%8C%81PC%E7%A7%BB%E5%8A%A8%E7%AB%AF%E4%BC%81%E4%B8%9A%E7%89%88%5D%5BKDocs%5D%20%E9%87%91%E5%B1%B1%E6%96%87%E6%A1%A3%E6%89%B9%E9%87%8F%E4%B8%8B%E8%BD%BD%E5%B0%8F%E5%8A%A9%E6%89%8B.meta.js
// ==/UserScript==

(function () {
    'use strict';

    /*
     * ┌──────────────────────────────────────────────────────────────────┐
     * │                    KDocs 批量下载工具 — 工作原理                  │
     * ├──────────────────────────────────────────────────────────────────┤
     * │                                                                │
     * │  整体流程：                                                     │
     * │  1. 脚本启动后，清理 localStorage 中的过期缓存条目               │
     * │  2. 通过自定义元素 <kdocs-downloader> + Shadow DOM 注入可拖拽     │
     * │     悬浮球，天然防止重复实例化                                     │
     * │  3. 用户点击悬浮球 → 右侧滑出操作面板（亮色主题，可全屏/缩放）     │
     * │  4. 面板打开时自动解析当前页面 URL，识别所处空间类型：              │
     * │     - 个人根目录 / 个人子文件夹 / 团队根目录 / 团队子文件夹       │
     * │     - 企业版个人空间 (/space/) / 企业版共享空间 (/ent/)           │
     * │     - 手机端 (/m/, /m/folder/) 各种变体                          │
     * │  5. 根据空间类型调用 KDocs API 获取文件列表（优先读 localStorage   │
     * │     缓存，TTL 5min；下载 URL 不缓存以确保链接有效性）             │
     * │  6. 以栈方式深度遍历所有子文件夹，构建完整的文件树                  │
     * │  7. 在面板中渲染文件树，用户通过三态复选框勾选要下载的文件           │
     * │  8. 点击下载后弹出下载方式选择器，支持四种策略：                    │
     * │     ①  单文件 → showSaveFilePicker（另存为对话框）                │
     * │     ②  多文件 → showDirectoryPicker（选目录，并发写入）           │
     * │     ③  浏览器 → 逐个触发 <a download> （顺序，避免拦截）          │
     * │     ④  ZIP    → JSZip 打包（剥除公共根目录）后触发下载             │
     * │                                                                │
     * │  代码分层：                                                     │
     * │  ┌──────────────┐                                              │
     * │  │ CONFIG/API    │ 常量、API 端点模板、类型枚举                   │
     * │  ├──────────────┤                                              │
     * │  │ Utils         │ 纯工具函数（时间格式化、大小格式化、fetchJSON） │
     * │  ├──────────────┤                                              │
     * │  │ CacheService  │ localStorage 持久缓存（TTL 自动过期、启动清理）│
     * │  ├──────────────┤                                              │
     * │  │ DataService   │ 所有网络请求封装（带缓存，下载 URL 除外）      │
     * │  ├──────────────┤                                              │
     * │  │ URL Parser    │ parsePageUrl + initRootAndFetch              │
     * │  ├──────────────┤                                              │
     * │  │ TreeModel     │ 树节点纯函数操作（选中、三态、收集选中文件）    │
     * │  ├──────────────┤                                              │
     * │  │ DownloadEngine│ 四种下载策略 + 并发控制                       │
     * │  ├──────────────┤                                              │
     * │  │ STYLES        │ CSS 字符串（亮色主题），注入 Shadow DOM         │
     * │  ├──────────────┤                                              │
     * │  │ KDocsUI       │ Web Component（extends HTMLElement）          │
     * │  │               │ 悬浮球、面板、关闭确认框、初次使用提示          │
     * │  └──────────────┘                                              │
     * │                                                                │
     * │  所有 UI 元素封装在 Shadow DOM 内，与宿主页面样式完全隔离。         │
     * │  所有 API 请求使用 credentials: 'include' 依赖登录态 Cookie。     │
     * │  面板支持全屏切换、拖拽左边缘调整宽度、移动端自动全宽。             │
     * └──────────────────────────────────────────────────────────────────┘
     */

    /* ═══════════════════════════════════════════════
     *  CONFIG — 常量 & API 端点
     * ═══════════════════════════════════════════════ */

    const CONFIG = {
        CONCURRENCY_LIMIT: 5,
        BALL_SIZE: 36,
        PANEL_WIDTH: 440,
        STORAGE_KEY: 'kdocs-downloader:settings',
        DRAG_THRESHOLD: 5,
        CACHE_TTL: 5 * 60 * 1000,  // 缓存有效期：5 分钟（毫秒）
    };

    /** 树节点类型 */
    const NODE_TYPE = {
        FOLDER: 'folder',
    };

    /** 页面 URL 类型 */
    const PAGE_TYPE = {
        PERSONAL_ROOT: 'personal_root',
        PERSONAL_FOLDER: 'personal_folder',
        TEAM_ROOT: 'team_root',
        TEAM_SUBFOLDER: 'team_subfolder',
    };

    /** 下载事件类型 */
    const DL_EVENT = {
        PROGRESS: 'progress',
        COMPLETE: 'complete',
        ERROR: 'error',
    };

    /** 复选框状态 */
    const CHECK_STATE = {
        INDETERMINATE: 'indeterminate',
    };

    const API = {
        metadata: (fileId) =>
            `https://drive.kdocs.cn/api/v5/files/${fileId}/metadata`,
        teamInfo: (teamId) =>
            `https://t.kdocs.cn/kdteam/api/v1/team/${teamId}`,
        rootFiles: () =>
            'https://drive.kdocs.cn/api/v5/groups/special/files?linkgroup=true&include=pic_thumbnail&with_link=true&review_pic_thumbnail=true&with_sharefolder_type=true&offset=0&count=99999&order=DESC&orderby=mtime&exclude_exts=&include_exts=',
        folderFiles: (groupid, parentid) =>
            `https://drive.kdocs.cn/api/v5/groups/${groupid}/files?linkgroup=true&parentid=${parentid}&include=&with_link=true&review_pic_thumbnail=true&offset=0&count=99999&order=DESC&orderby=mtime&exclude_exts=&include_exts=`,
        download: (groupid, id) =>
            `https://drive.kdocs.cn/api/v5/groups/${groupid}/files/${id}/download?isblocks=false&support_checksums=md5,sha1,sha224,sha256,sha384,sha512`,
    };

    /* ═══════════════════════════════════════════════
     *  UTILS — 工具函数
     * ═══════════════════════════════════════════════ */

    const Utils = {
        /** 秒级 Unix 时间戳 → 本地时间字符串，null-safe */
        formatMtime(timestamp) {
            if (!timestamp) return null;
            return new Date(timestamp * 1000).toLocaleString();
        },

        /** 字节数 → 人类可读大小 */
        formatFileSize(bytes) {
            if (!bytes || bytes === 0) return '0 B';
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(1024));
            return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${units[i]}`;
        },

        /** 格式化时间用于 ZIP 文件名：yyyy_MM_dd_HH_mm_ss */
        formatZipTimestamp(date = new Date()) {
            const pad = (n) => String(n).padStart(2, '0');
            const y = date.getFullYear();
            const m = pad(date.getMonth() + 1);
            const d = pad(date.getDate());
            const hh = pad(date.getHours());
            const mm = pad(date.getMinutes());
            const ss = pad(date.getSeconds());
            return `${y}_${m}_${d}_${hh}_${mm}_${ss}`;
        },

        /** 安全获取 JSON（带 credentials） */
        async fetchJSON(url) {
            const res = await fetch(url, { credentials: 'include' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },

        /** 将 API 文件对象映射为内部树节点（用于文件树） */
        mapFileNode(file) {
            return {
                id: file.id,
                groupid: file.groupid,
                parentid: file.parentid,
                name: file.fname,
                type: file.ftype,
                size: file.fsize,
                mtime: Utils.formatMtime(file.mtime),
                linkUrl: file.link_url || '',
                children: [],
                checked: false,
            };
        },

        /** 创建根节点 */
        createRootNode(overrides = {}) {
            return {
                name: '根目录',
                children: [],
                id: 'root',
                type: NODE_TYPE.FOLDER,
                checked: false,
                mtime: null,
                ...overrides,
            };
        },

        /** 限制数值范围 */
        clamp(val, min, max) {
            return Math.max(min, Math.min(max, val));
        },
    };

    /* ═══════════════════════════════════════════════
     *  CACHE — TTL 内存缓存
     * ═══════════════════════════════════════════════
     *
     *  缓存文件夹内容、团队信息、元数据等 API 响应，
     *  减少重复请求、降低 API throttle 风险。
     *  下载 URL 不缓存（有时效性，缓存会导致链接过期）。
     */

    const CacheService = {
        _PREFIX: 'kdocs-downloader:cache:',
        _hits: 0,

        /**
         * 获取缓存项。返回 undefined 表示未命中或已过期。
         * @param {string} key
         */
        get(key) {
            try {
                const raw = localStorage.getItem(this._PREFIX + key);
                if (!raw) return undefined;
                const entry = JSON.parse(raw);
                if (Date.now() > entry.expiry) {
                    localStorage.removeItem(this._PREFIX + key);
                    return undefined;
                }
                this._hits++;
                return entry.data;
            } catch {
                return undefined;
            }
        },

        /**
         * 写入缓存项。
         * @param {string} key
         * @param {any} data
         * @param {number} [ttl=CONFIG.CACHE_TTL]
         */
        set(key, data, ttl = CONFIG.CACHE_TTL) {
            try {
                const entry = JSON.stringify({ data, expiry: Date.now() + ttl });
                localStorage.setItem(this._PREFIX + key, entry);
            } catch (e) {
                // localStorage 满或不可用时静默失败
                console.warn('[KDocs] 缓存写入失败:', e);
            }
        },

        /** 清空所有 kdocs 缓存（手动刷新时调用） */
        clear() {
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(this._PREFIX)) keysToRemove.push(k);
            }
            keysToRemove.forEach(k => localStorage.removeItem(k));
            this._hits = 0;
            console.info(`[KDocs] 缓存已清空 (${keysToRemove.length} 条)`);
        },

        /** 自动清理已过期的缓存条目（启动时调用） */
        purgeExpired() {
            const now = Date.now();
            let purged = 0;
            const keysToCheck = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(this._PREFIX)) keysToCheck.push(k);
            }
            for (const k of keysToCheck) {
                try {
                    const entry = JSON.parse(localStorage.getItem(k));
                    if (!entry || now > entry.expiry) {
                        localStorage.removeItem(k);
                        purged++;
                    }
                } catch {
                    localStorage.removeItem(k); // 损坏的条目直接删除
                    purged++;
                }
            }
            if (purged > 0) console.info(`[KDocs] 已清理 ${purged} 条过期缓存`);
        },

        /** 重置命中计数器（每次加载前调用） */
        resetHits() {
            this._hits = 0;
        },

        /** 本轮缓存命中次数 */
        get hits() {
            return this._hits;
        },

        /** 当前缓存条目数（用于调试） */
        get size() {
            let count = 0;
            for (let i = 0; i < localStorage.length; i++) {
                if (localStorage.key(i)?.startsWith(this._PREFIX)) count++;
            }
            return count;
        },
    };

    /* ═══════════════════════════════════════════════
     *  API LAYER — 数据获取（带缓存）
     * ═══════════════════════════════════════════════ */

    const DataService = {
        /** 获取团队信息（缓存 key: team:{teamId}） */
        async fetchTeamInfo(teamId) {
            const cacheKey = `team:${teamId}`;
            const cached = CacheService.get(cacheKey);
            if (cached) return cached;

            try {
                const data = await Utils.fetchJSON(API.teamInfo(teamId));
                if (data.code === 0 && data.data) {
                    const result = {
                        name: data.data.name || `团队-${teamId}`,
                        mtime: Utils.formatMtime(data.data.updateTime),
                    };
                    CacheService.set(cacheKey, result);
                    return result;
                }
            } catch (e) {
                console.warn('[KDocs] 获取团队信息失败:', e);
            }
            return { name: `团队-${teamId}`, mtime: null };
        },

        /** 获取文件/文件夹元数据（缓存 key: meta:{fileId}） */
        async fetchFileMetadata(fileId) {
            const cacheKey = `meta:${fileId}`;
            const cached = CacheService.get(cacheKey);
            if (cached) return cached;

            const data = await Utils.fetchJSON(API.metadata(fileId));
            const result = data.result === 'ok' ? data.fileinfo : null;
            if (result) CacheService.set(cacheKey, result);
            return result;
        },

        /** 获取个人空间根目录内容（缓存 key: root） */
        async fetchRootContents(parentNode) {
            const cacheKey = 'root';
            const cached = CacheService.get(cacheKey);
            if (cached) {
                // 从缓存恢复时需要深拷贝，避免 checked 状态污染缓存
                parentNode.children = cached.map(n => ({ ...n, children: [], checked: false }));
                return;
            }

            const data = await Utils.fetchJSON(API.rootFiles());
            if (data.result === 'ok') {
                const nodes = data.files.map(Utils.mapFileNode);
                CacheService.set(cacheKey, nodes);
                parentNode.children = nodes;
            }
        },

        /** 获取指定文件夹子内容（缓存 key: folder:{groupid}:{id}） */
        async fetchFolderContents(folderNode) {
            const cacheKey = `folder:${folderNode.groupid}:${folderNode.id}`;
            const cached = CacheService.get(cacheKey);
            if (cached) {
                folderNode.children = cached.map(n => ({ ...n, children: [], checked: false }));
                return;
            }

            const data = await Utils.fetchJSON(API.folderFiles(folderNode.groupid, folderNode.id));
            if (data.result === 'ok') {
                const nodes = data.files.map(Utils.mapFileNode);
                CacheService.set(cacheKey, nodes);
                folderNode.children = nodes;
            }
        },

        /** 深度遍历所有子文件夹（栈式），支持进度回调 */
        async processFolderStack(rootNode, onProgress) {
            const stack = rootNode.children.filter(n => n.type === NODE_TYPE.FOLDER);
            let processedFolders = 0;
            let fileCount = rootNode.children.filter(n => n.type !== NODE_TYPE.FOLDER).length;

            const notify = () => {
                if (typeof onProgress === 'function') {
                    onProgress(processedFolders, fileCount);
                }
            };

            notify();

            while (stack.length > 0) {
                const folder = stack.pop();
                await DataService.fetchFolderContents(folder);
                processedFolders++;
                const children = folder.children || [];
                for (const c of children) {
                    if (c.type === NODE_TYPE.FOLDER) {
                        stack.push(c);
                    } else {
                        fileCount++;
                    }
                }
                notify();
            }
        },

        /** 获取文件下载链接 */
        async fetchDownloadUrl(groupid, fileId) {
            const data = await Utils.fetchJSON(API.download(groupid, fileId));
            if (data.result !== 'ok' || !data.url) {
                throw new Error('无法获取下载链接');
            }
            return data.url;
        },
    };

    /* ═══════════════════════════════════════════════
     *  URL PARSER — 页面类型解析
     * ═══════════════════════════════════════════════
     *
     *  KDocs 页面 URL 格式与对应类型：
     *
     *  ┌─────────────────────────────────────────────────────────────────┐
     *  │ URL 模式                              │ 解析结果               │
     *  ├─────────────────────────────────────────────────────────────────┤
     *  │ /mine/{fileId}                        │ PERSONAL_FOLDER        │
     *  │ /team/{teamId}?folderid={fid}         │ TEAM_ROOT (带 folderid)│
     *  │ /team/{teamId}/{folderId}             │ TEAM_SUBFOLDER         │
     *  │ /team/{teamId}                        │ TEAM_ROOT (默认)       │
     *  │ /m/folder/{groupid}/{folderid}        │ PERSONAL_FOLDER (手机) │
     *  │ /m/folder/{tid}?gid={gid}&fid={fid}   │ TEAM_SUBFOLDER (手机)  │
     *  │ /m/folder/{teamId}                    │ TEAM_ROOT (手机)       │
     *  │ /m/{groupid}/{folderId}               │ TEAM_SUBFOLDER (手机)  │
     *  │ /space/{orgid}/{groupid}              │ TEAM_ROOT (企业个人)   │
     *  │ /space/{orgid}/{groupid}/{fid}        │ TEAM_SUBFOLDER (企业)  │
     *  │ /ent/{orgid}/{groupid}                │ TEAM_ROOT (企业共享)   │
     *  │ /ent/{orgid}/{groupid}/{fid}          │ TEAM_SUBFOLDER (企业)  │
     *  │ 其他 (如 /latest, /recent 等)          │ PERSONAL_ROOT          │
     *  └─────────────────────────────────────────────────────────────────┘
     */

    /**
     * 解析当前页面 URL，识别用户所处的空间类型和关键参数。
     * 返回值用于 initRootAndFetch() 分发到对应的数据加载逻辑。
     *
     * @returns {{ type: string, fileId?: string, teamId?: string, folderId?: string }}
     */
    function parsePageUrl() {
        const urlStr = window.location.href;
        const url = new URL(urlStr);

        // ── 手机端网页（/m/ 路径）──
        if (urlStr.includes('/m/')) {
            const segments = url.pathname.split('/').filter(Boolean);
            // segments[0] = 'm'

            if (segments[1] === 'folder') {
                // /m/folder/...
                const gidParam = url.searchParams.get('gid');
                const fidParam = url.searchParams.get('fid');

                if (gidParam && fidParam) {
                    // 团队文件夹: /m/folder/{teamid}?gid={groupid}&fid={folderid}
                    return { type: PAGE_TYPE.TEAM_SUBFOLDER, teamId: segments[2], folderId: fidParam };
                }
                if (segments.length >= 4) {
                    // 个人文件夹: /m/folder/{groupid}/{folderid}
                    return { type: PAGE_TYPE.PERSONAL_FOLDER, fileId: segments[3], groupId: segments[2] };
                }
                if (segments.length >= 3) {
                    // 团队/共享根目录: /m/folder/{groupid}
                    return { type: PAGE_TYPE.TEAM_ROOT, teamId: segments[2], folderId: `-${segments[2]}` };
                }
            } else if (segments.length >= 3) {
                // 手机端子文件夹: /m/{groupid}/{folderId}
                return { type: PAGE_TYPE.TEAM_SUBFOLDER, teamId: segments[1], folderId: segments[2] };
            }
        }

        // ── 企业版个人空间（/space/ 路径）──
        // URL 格式: /space/{orgid}/{groupid} 或 /space/{orgid}/{groupid}/{folderid}
        // orgid 可忽略，groupid 用作 API 的 groupid
        if (urlStr.includes('/space/')) {
            const segments = url.pathname.split('/').filter(Boolean);
            // segments: ['space', orgid, groupid] 或 ['space', orgid, groupid, folderid]
            const groupid = segments[2];
            if (segments.length >= 4) {
                return { type: PAGE_TYPE.TEAM_SUBFOLDER, teamId: groupid, folderId: segments[3] };
            }
            return { type: PAGE_TYPE.TEAM_ROOT, teamId: groupid, folderId: `-${groupid}` };
        }

        // ── 企业版共享空间（/ent/ 路径）──
        // URL 格式: /ent/{orgid}/{groupid} 或 /ent/{orgid}/{groupid}/{folderid}
        // orgid 可忽略，groupid 用作 API 的 groupid
        if (urlStr.includes('/ent/')) {
            const segments = url.pathname.split('/').filter(Boolean);
            // segments: ['ent', orgid, groupid] 或 ['ent', orgid, groupid, folderid]
            const groupid = segments[2];
            if (segments.length >= 4) {
                return { type: PAGE_TYPE.TEAM_SUBFOLDER, teamId: groupid, folderId: segments[3] };
            }
            return { type: PAGE_TYPE.TEAM_ROOT, teamId: groupid, folderId: `-${groupid}` };
        }

        // ── 个人空间子文件夹 ──
        // URL 格式: https://www.kdocs.cn/mine/{fileId}
        // 从 /mine/ 后截取 fileId（去除路径后缀和查询参数）
        if (urlStr.includes('/mine/')) {
            const fileId = urlStr.split('/mine/')[1].split('/')[0].split('?')[0];
            return { type: PAGE_TYPE.PERSONAL_FOLDER, fileId };
        }

        // ── 团队空间 ──
        // URL 格式: https://www.kdocs.cn/team/{teamId}/...
        if (urlStr.includes('/team/')) {
            const segments = url.pathname.split('/').filter(Boolean);
            const teamId = segments[1];
            const folderIdParam = url.searchParams.get('folderid');

            if (folderIdParam) {
                return { type: PAGE_TYPE.TEAM_ROOT, teamId, folderId: folderIdParam };
            }
            if (segments.length >= 3) {
                return { type: PAGE_TYPE.TEAM_SUBFOLDER, teamId, folderId: segments[2] };
            }
            return { type: PAGE_TYPE.TEAM_ROOT, teamId, folderId: `-${teamId}` };
        }

        // ── 默认：个人空间根目录 ──
        return { type: PAGE_TYPE.PERSONAL_ROOT };
    }

    /** 根据页面类型初始化根节点并获取内容 */
    async function initRootAndFetch(pageInfo) {
        switch (pageInfo.type) {
            case PAGE_TYPE.PERSONAL_ROOT: {
                const root = Utils.createRootNode();
                await DataService.fetchRootContents(root);
                return root;
            }
            case PAGE_TYPE.PERSONAL_FOLDER: {
                let groupid, folderName, mtime;
                if (pageInfo.groupId) {
                    // 手机端 URL 已经提供 groupid，无需额外获取元数据
                    groupid = pageInfo.groupId;
                    const info = await DataService.fetchFileMetadata(pageInfo.fileId).catch(() => null);
                    folderName = info?.fname || '文件夹';
                    mtime = Utils.formatMtime(info?.mtime);
                } else {
                    const info = await DataService.fetchFileMetadata(pageInfo.fileId);
                    if (!info) throw new Error('无法获取文件夹元数据');
                    groupid = info.groupid;
                    folderName = info.fname;
                    mtime = Utils.formatMtime(info.mtime);
                }
                const root = Utils.createRootNode({
                    name: folderName,
                    id: pageInfo.fileId,
                    groupid,
                    mtime,
                });
                await DataService.fetchFolderContents(root);
                return root;
            }
            case PAGE_TYPE.TEAM_ROOT: {
                const teamInfo = await DataService.fetchTeamInfo(pageInfo.teamId);
                const root = Utils.createRootNode({
                    name: teamInfo.name,
                    id: pageInfo.folderId,
                    groupid: pageInfo.teamId,
                    mtime: teamInfo.mtime,
                });
                await DataService.fetchFolderContents(root);
                return root;
            }
            case PAGE_TYPE.TEAM_SUBFOLDER: {
                const [teamInfo, folderInfo] = await Promise.all([
                    DataService.fetchTeamInfo(pageInfo.teamId),
                    DataService.fetchFileMetadata(pageInfo.folderId).catch(() => null),
                ]);
                const root = Utils.createRootNode({
                    name: folderInfo?.fname || teamInfo.name,
                    id: pageInfo.folderId,
                    groupid: pageInfo.teamId,
                    mtime: Utils.formatMtime(folderInfo?.mtime) || teamInfo.mtime,
                });
                await DataService.fetchFolderContents(root);
                return root;
            }
            default:
                throw new Error(`未知页面类型: ${pageInfo.type}`);
        }
    }

    /* ═══════════════════════════════════════════════
     *  TREE MODEL — 树节点选中状态操作
     * ═══════════════════════════════════════════════ */

    const TreeModel = {
        /** 递归设置子树选中状态 */
        setSelection(node, state) {
            node.checked = state;
            if (node.children?.length) {
                node.children.forEach(c => TreeModel.setSelection(c, state));
            }
        },

        /** 递归更新父节点三态 */
        updateCheckboxStates(node) {
            if (node.type !== NODE_TYPE.FOLDER || !node.children?.length) return;

            node.children.forEach(c => TreeModel.updateCheckboxStates(c));

            const allChecked = node.children.every(c => c.checked === true);
            const someChecked = node.children.some(c => c.checked === true || c.checked === CHECK_STATE.INDETERMINATE);

            node.checked = allChecked ? true : someChecked ? CHECK_STATE.INDETERMINATE : false;
        },

        /** 检查子树是否全选 */
        isAllSelected(node) {
            if (node.children?.length) {
                return node.children.every(c => TreeModel.isAllSelected(c));
            }
            return node.checked === true;
        },

        /** 收集所有选中的非文件夹节点 */
        getSelectedFiles(node, path = '') {
            let files = [];
            if (node.checked === true && node.type !== NODE_TYPE.FOLDER) {
                files.push({
                    id: node.id,
                    groupid: node.groupid,
                    name: node.name,
                    path,
                    type: node.type,
                });
            }
            if (node.children?.length) {
                const newPath = path ? `${path}/${node.name}` : node.name;
                for (const child of node.children) {
                    files = files.concat(
                        TreeModel.getSelectedFiles(child, node.type === NODE_TYPE.FOLDER ? newPath : path)
                    );
                }
            }
            return files;
        },
    };

    /* ═══════════════════════════════════════════════
     *  DOWNLOAD ENGINE — 四种下载策略
     *  1) 单文件另存为（File System Access API）
     *  2) 批量保存到目录（File System Access API）
     *  3) ZIP 打包下载（JSZip）
     *  4) 纯浏览器多文件下载（不依赖 FS API）
     * ═══════════════════════════════════════════════ */

    const DownloadEngine = {
        /** 带进度的 fetch → Uint8Array */
        async fetchWithProgress(url, onProgress) {
            const response = await fetch(url, { credentials: 'include' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const contentLength = response.headers.get('Content-Length');
            const total = contentLength ? parseInt(contentLength) : null;
            const reader = response.body.getReader();
            const chunks = [];
            let loaded = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                loaded += value.length;
                if (total && onProgress) {
                    onProgress({ loaded, total, percent: Math.round((loaded / total) * 100) });
                }
            }

            const combined = new Uint8Array(loaded);
            let pos = 0;
            for (const chunk of chunks) {
                combined.set(chunk, pos);
                pos += chunk.length;
            }
            return combined;
        },

        /** 并发控制下载（用于 ZIP 模式） */
        async downloadWithConcurrency(files, concurrency, progressCb) {
            const results = [];
            const queue = [...files];
            let done = 0;

            async function worker() {
                while (queue.length > 0) {
                    const file = queue.shift();
                    try {
                        const dlUrl = await DataService.fetchDownloadUrl(file.groupid, file.id);
                        const data = await DownloadEngine.fetchWithProgress(dlUrl, (evt) => {
                            progressCb({ type: DL_EVENT.PROGRESS, file, percent: evt.percent, done, total: files.length });
                        });
                        done++;
                        progressCb({ type: DL_EVENT.COMPLETE, file, done, total: files.length });
                        results.push({ file, data, success: true });
                    } catch (error) {
                        console.error(`[KDocs] 下载失败: ${file.name}`, error);
                        done++;
                        progressCb({ type: DL_EVENT.ERROR, file, error, done, total: files.length });
                        results.push({ file, error, success: false });
                    }
                }
            }

            await Promise.all(
                Array(Math.min(concurrency, files.length)).fill(null).map(worker)
            );
            return results;
        },

        /** 策略 1：单文件 showSaveFilePicker */
        async downloadSingleFile(file, ui) {
            const dlUrl = await DataService.fetchDownloadUrl(file.groupid, file.id);
            const fileHandle = await window.showSaveFilePicker({ suggestedName: file.name });
            const writable = await fileHandle.createWritable();

            ui.showProgress(`正在下载: ${file.name}`, 0);
            ui.log?.({
                level: 'info',
                message: `开始下载单个文件: ${file.name}`,
                file,
            });

            const response = await fetch(dlUrl, { credentials: 'include' });
            if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

            const total = parseInt(response.headers.get('Content-Length') || '0', 10) || null;
            const reader = response.body.getReader();
            let loaded = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                await writable.write(value);
                loaded += value.length;
                if (total) {
                    const pct = Math.round((loaded / total) * 100);
                    ui.showProgress(
                        `${pct}% (${Utils.formatFileSize(loaded)} / ${Utils.formatFileSize(total)})`,
                        pct
                    );
                }
            }

            await writable.close();
            ui.showProgress(`已保存: ${file.name}`, 100);
            ui.log?.({
                level: 'success',
                message: `单文件保存完成: ${file.name}`,
                file,
            });
        },

        /** 策略 2：多文件 showDirectoryPicker — 边下载边写入 */
        async downloadToDirectory(files, concurrency, dirHandle, failedSet, ui) {
            const total = files.length;
            let finished = 0;
            let saved = 0;

            ui.showProgress(`准备下载 ${total} 个文件 (并发: ${concurrency})...`, 0);
            ui.log?.({
                level: 'info',
                message: `开始批量下载到本地文件夹，共 ${total} 个文件（并发 ${concurrency}）`,
            });

            async function getOrCreateDir(base, relPath) {
                if (!relPath) return base;
                let dir = base;
                for (const seg of relPath.split('/').filter(Boolean)) {
                    dir = await dir.getDirectoryHandle(seg, { create: true });
                }
                return dir;
            }

            const queue = [...files];

            async function worker() {
                while (queue.length > 0) {
                    const file = queue.shift();
                    const fullPath = file.path ? `${file.path}/${file.name}` : file.name;
                    try {
                        const dlUrl = await DataService.fetchDownloadUrl(file.groupid, file.id);
                        const dh = await getOrCreateDir(dirHandle, file.path || '');
                        const fh = await dh.getFileHandle(file.name, { create: true });
                        const writable = await fh.createWritable();

                        const response = await fetch(dlUrl, { credentials: 'include' });
                        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

                        const contentLen = parseInt(response.headers.get('Content-Length') || '0', 10) || null;
                        const reader = response.body.getReader();
                        let loaded = 0;

                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            await writable.write(value);
                            loaded += value.length;
                            if (contentLen) {
                                const pct = Math.round((loaded / contentLen) * 100);
                                ui.showFileStatus(`正在下载: ${fullPath} (${pct}%)`);
                            }
                        }

                        await writable.close();
                        finished++;
                        saved++;
                        ui.showProgress(
                            `已完成 ${finished}/${total}，成功 ${saved} 个`,
                            Math.round((finished / total) * 100)
                        );
                        ui.log?.({
                            level: 'success',
                            message: `保存完成: ${fullPath}`,
                            file,
                        });
                    } catch (error) {
                        console.error(`[KDocs] 下载失败: ${fullPath}`, error);
                        finished++;
                        failedSet.add(file.id);
                        ui.showProgress(
                            `已完成 ${finished}/${total}（部分失败）`,
                            Math.round((finished / total) * 100)
                        );
                        const friendly = DownloadEngine._friendlyErrorMessage(error);
                        ui.showFileStatus(`失败: ${fullPath} - ${friendly}`);
                        ui.log?.({
                            level: 'error',
                            message: `下载失败: ${fullPath} - ${friendly}`,
                            file,
                            error,
                        });
                    }
                }
            }

            await Promise.all(
                Array(Math.min(concurrency, files.length)).fill(null).map(worker)
            );

            ui.showProgress(
                saved === 0
                    ? '没有文件成功保存，请检查错误'
                    : `全部完成：成功保存 ${saved}/${total} 文件`,
                100
            );
            if (failedSet.size > 0) {
                ui.log?.({
                    level: 'warn',
                    message: `本次下载有 ${failedSet.size} 个文件失败，可重新勾选失败文件后重试。`,
                });
            } else {
                ui.log?.({
                    level: 'success',
                    message: `全部完成：成功保存 ${saved}/${total} 个文件。`,
                });
            }
        },

        /** 策略 3：JSZip 打包下载 */
        async downloadAndZip(files, concurrency, failedSet, ui) {
            ui.showProgress(`准备下载 ${files.length} 个文件...`, 0);
            ui.log?.({
                level: 'info',
                message: `开始打包 ZIP 下载，共 ${files.length} 个文件（并发 ${concurrency}）`,
            });

            const results = await DownloadEngine.downloadWithConcurrency(
                files,
                concurrency,
                ({ type, file, percent, done, total, error }) => {
                    const fp = file.path ? `${file.path}/${file.name}` : file.name;
                    switch (type) {
                        case DL_EVENT.PROGRESS:
                            ui.showFileStatus(`正在下载: ${fp} (${percent}%)`);
                            break;
                        case DL_EVENT.COMPLETE:
                            ui.showProgress(`已下载 ${done}/${total}`, Math.round((done / total) * 100));
                            ui.showFileStatus(`已完成: ${fp}`);
                            ui.log?.({
                                level: 'success',
                                message: `下载完成: ${fp}`,
                                file,
                            });
                            break;
                        case DL_EVENT.ERROR:
                            failedSet.add(file.id);
                            ui.showProgress(`已下载 ${done}/${total}（有失败）`, Math.round((done / total) * 100));
                            {
                                const friendly = DownloadEngine._friendlyErrorMessage(error);
                                ui.showFileStatus(`失败: ${fp} - ${friendly}`);
                                ui.log?.({
                                    level: 'error',
                                    message: `下载失败: ${fp} - ${friendly}`,
                                    file,
                                    error,
                                });
                            }
                            break;
                    }
                }
            );

            // ZIP 打包
            ui.showZipProgress('正在打包 ZIP...', 0);
            ui.log?.({
                level: 'info',
                message: '开始打包 ZIP 文件...',
            });
            const zip = new JSZip();
            let added = 0;

            // 预处理路径，去掉无意义的“根目录”前缀，并计算共同根目录名
            const normalized = [];
            for (const r of results) {
                if (!r.success) continue;
                const file = r.file;
                const pathParts = file.path ? file.path.split('/').filter(Boolean) : [];
                if (pathParts[0] === '根目录') {
                    pathParts.shift();
                }
                const segments = [...pathParts, file.name];
                normalized.push({ segments, file: r.file, data: r.data });
            }

            if (normalized.length === 0) {
                ui.showZipProgress('没有文件可打包', 0);
                ui.log?.({
                    level: 'warn',
                    message: '没有成功下载的文件可打包为 ZIP。',
                });
                return;
            }

            let commonRootName = null;
            if (normalized.every(n => n.segments.length > 1)) {
                const first = normalized[0].segments[0];
                if (normalized.every(n => n.segments[0] === first)) {
                    commonRootName = first;
                }
            }

            // 如果所有文件共享同一个根文件夹，去掉这个根前缀
            if (commonRootName) {
                for (const n of normalized) {
                    n.segments.shift();
                }
            }

            for (const n of normalized) {
                const relPath = n.segments.join('/');
                zip.file(relPath, n.data);
                added++;
                ui.showZipProgress(`已添加 ${added}/${files.length}`, Math.round((added / files.length) * 100));
            }

            if (added === 0) {
                ui.showZipProgress('没有文件可打包', 0);
                ui.log?.({
                    level: 'warn',
                    message: '没有成功下载的文件可打包为 ZIP。',
                });
                return;
            }

            ui.showZipProgress('正在生成 ZIP...', 50);
            const blob = await zip.generateAsync(
                { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, streamFiles: true },
                (meta) => ui.showZipProgress(`生成 ZIP: ${meta.percent.toFixed(1)}%`, meta.percent)
            );

            const zipUrl = URL.createObjectURL(blob);
            const ts = Utils.formatZipTimestamp(new Date());
            const baseName = commonRootName || '金山文档';
            const zipName = `${baseName}_${ts}.zip`;
            const a = document.createElement('a');
            a.href = zipUrl;
            a.download = zipName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(zipUrl), 200);

            ui.showProgress(`已保存为 ${zipName}`, 100);
            ui.showZipProgress('ZIP 打包完成!', 100);
            if (failedSet.size > 0) {
                ui.log?.({
                    level: 'warn',
                    message: `ZIP 已生成为 ${zipName}，但仍有 ${failedSet.size} 个文件下载失败，可重新勾选失败文件后重试。`,
                });
            } else {
                ui.log?.({
                    level: 'success',
                    message: `ZIP 打包完成，已保存为 ${zipName}。`,
                });
            }
        },

        /** 策略 4：浏览器逐个下载（不使用 File System API） */
        async downloadViaBrowser(files, concurrency, ui) {
            const total = files.length;
            ui.showProgress(`准备通过浏览器下载 ${total} 个文件...`, 0);
            ui.log?.({
                level: 'info',
                message: `开始通过浏览器逐个下载，共 ${total} 个文件（并发 ${concurrency}，可能会触发浏览器多文件下载提示）。`,
            });
            ui.log?.({
                level: 'warn',
                message: '⚠️ 请在浏览器弹出的对话框中允许「下载多个文件」权限，否则部分文件可能无法保存。',
            });

            let finished = 0;
            const queue = [...files];

            async function sleep(ms) {
                return new Promise(resolve => setTimeout(resolve, ms));
            }

            async function worker() {
                while (queue.length > 0) {
                    const file = queue.shift();
                    if (!file) return;
                    const fp = file.path ? `${file.path}/${file.name}` : file.name;
                    try {
                        const dlUrl = await DataService.fetchDownloadUrl(file.groupid, file.id);
                        const a = document.createElement('a');
                        a.href = dlUrl;
                        a.download = file.name;
                        a.style.display = 'none';
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        finished++;
                        const pct = Math.round((finished / total) * 100);
                        ui.showProgress(`浏览器已触发 ${finished}/${total} 个文件下载`, pct);
                        ui.showFileStatus(`已触发浏览器下载: ${fp}`);
                        ui.log?.({
                            level: 'success',
                            message: `浏览器已触发展开下载: ${fp}`,
                            file,
                        });
                    } catch (error) {
                        console.error('[KDocs] 浏览器下载触发失败:', file.name, error);
                        finished++;
                        const pct = Math.round((finished / total) * 100);
                        const friendly = DownloadEngine._friendlyErrorMessage(error);
                        ui.showProgress(`浏览器下载触发进度 ${finished}/${total}（有失败）`, pct);
                        ui.showFileStatus(`浏览器下载触发失败: ${fp} - ${friendly}`);
                        ui.log?.({
                            level: 'error',
                            message: `浏览器下载触发失败: ${fp} - ${friendly}`,
                            file,
                            error,
                        });
                    }
                    // 适当间隔，降低被浏览器拦截的概率
                    await sleep(500);
                }
            }
            // 浏览器下载强制逐个顺序触发，避免并发被浏览器拦截
            await Promise.all(
                Array(1).fill(null).map(worker)
            );

            ui.showProgress('浏览器下载触发完成，请在下载管理器中查看进度。', 100);
            ui.log?.({
                level: 'info',
                message: '浏览器已触发所有选中文件的下载，请在浏览器下载管理器中查看实际进度和结果。',
            });
        },

        /**
         * 将常见下载错误转换为人类可读的友好中文提示。
         * 主要用于日志区与进度区的错误展示。
         */
        _friendlyErrorMessage(error) {
            if (!error) return '未知错误';
            const msg = String(error?.message || error).toUpperCase();
            if (/HTTP\s*403/.test(msg)) return '⛔ 无权限访问此文件 (HTTP 403)';
            if (/HTTP\s*404/.test(msg)) return '🔍 文件不存在 (HTTP 404)';
            if (/HTTP\s*429/.test(msg)) return '⏳ 请求过于频繁，请稍后重试 (HTTP 429)';
            if (/NETWORK|FAILED TO FETCH|TYPEERROR/.test(msg)) return '🌐 网络连接异常，请检查网络后重试';
            if (/DOWNLOAD URL|无法获取下载链接/.test(msg)) return '无法获取下载链接，请稍后重试或检查登录状态';
            return msg || '未知错误';
        },
    };

    /* ═══════════════════════════════════════════════
     *  CSS — Shadow DOM 内的全部样式
     * ═══════════════════════════════════════════════ */

    const STYLES = /* css */ `
        :host {
            --accent: #2069E0;
            --accent-hover: #1B5ACC;
            --accent-glow: rgba(32, 105, 224, 0.25);
            --bg-panel: rgba(255, 255, 255, 0.96);
            --bg-card: rgba(0, 0, 0, 0.03);
            --bg-card-hover: rgba(0, 0, 0, 0.06);
            --text-primary: #1a1a2e;
            --text-secondary: rgba(26, 26, 46, 0.55);
            --border: rgba(0, 0, 0, 0.08);
            --success: #00A870;
            --danger: #E53E3E;
            --warning: #D97706;
            --radius: 12px;
            --radius-sm: 8px;
            --transition: 0.25s cubic-bezier(0.4, 0, 0.2, 1);

            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
                         'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
            font-size: 13px;
            line-height: 1.5;
            color: var(--text-primary);
        }

        /* ── 悬浮球 ── */
        .fab {
            position: fixed;
            width: ${CONFIG.BALL_SIZE}px;
            height: ${CONFIG.BALL_SIZE}px;
            border-radius: 50%;
            background: linear-gradient(135deg, #2069E0 0%, #4A90F0 100%);
            box-shadow: 0 2px 8px rgba(32, 105, 224, 0.35),
                        0 0 0 2px rgba(32, 105, 224, 0.1);
            cursor: grab;
            z-index: 2147483647;
            display: flex;
            align-items: center;
            justify-content: center;
            user-select: none;
            touch-action: none;
            transition: box-shadow var(--transition), transform var(--transition), opacity 0.2s ease;
        }
        .fab.hidden {
            display: none !important;
        }
        .fab:hover {
            box-shadow: 0 4px 12px rgba(32, 105, 224, 0.45),
                        0 0 0 3px rgba(32, 105, 224, 0.15);
            transform: scale(1.12);
        }
        .fab:active { cursor: grabbing; }
        .fab.left.half-hidden {
            transform: translateX(-${CONFIG.BALL_SIZE / 2}px);
        }
        .fab.right.half-hidden {
            transform: translateX(${CONFIG.BALL_SIZE / 2}px);
        }
        .fab.left.half-hidden:hover,
        .fab.right.half-hidden:hover {
            transform: translateX(0) scale(1.08);
        }
        .fab-close {
            position: absolute;
            top: -3px;
            right: -3px;
            width: 15px;
            height: 15px;
            border-radius: 50%;
            background: rgba(0, 0, 0, 0.65);
            color: #fff;
            font-size: 10px;
            display: none;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            box-shadow: 0 1px 4px rgba(0,0,0,0.35);
            z-index: 1;
        }
        .fab:hover .fab-close {
            display: flex;
        }
        .fab.snapping {
            transition: left 0.35s cubic-bezier(0.34, 1.56, 0.64, 1),
                        top 0.35s cubic-bezier(0.34, 1.56, 0.64, 1),
                        box-shadow var(--transition),
                        transform var(--transition);
        }
        .fab svg {
            width: 18px;
            height: 18px;
            fill: white;
            pointer-events: none;
        }

        /* ── 遮罩 ── */
        .backdrop {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.2);
            backdrop-filter: blur(2px);
            z-index: 2147483640;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.3s ease;
        }
        .backdrop.open {
            opacity: 1;
            pointer-events: auto;
        }

        /* ── 面板 ── */
        .panel {
            position: fixed;
            top: 0;
            right: 0;
            width: ${CONFIG.PANEL_WIDTH}px;
            min-width: 320px;
            max-width: 100vw;
            height: 100%;
            background: var(--bg-panel);
            backdrop-filter: blur(24px) saturate(1.4);
            -webkit-backdrop-filter: blur(24px) saturate(1.4);
            border-left: 1px solid var(--border);
            z-index: 2147483645;
            transform: translateX(100%);
            transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1),
                        width 0s;
            display: flex;
            flex-direction: column;
            box-shadow: -4px 0 24px rgba(0, 0, 0, 0.08);
        }
        .panel.open {
            transform: translateX(0);
        }
        .panel.fullscreen {
            width: 100vw !important;
        }

        /* ── 拖拽调整宽度句柄 ── */
        .resize-handle {
            position: absolute;
            left: 0;
            top: 0;
            width: 6px;
            height: 100%;
            cursor: col-resize;
            z-index: 10;
            transition: background 0.2s;
        }
        .resize-handle:hover,
        .resize-handle.active {
            background: var(--accent);
            opacity: 0.4;
        }

        /* ── 面板 Header ── */
        .panel-header {
            padding: 20px 20px 16px;
            border-bottom: 1px solid var(--border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-shrink: 0;
        }
        .panel-title {
            font-size: 17px;
            font-weight: 600;
            letter-spacing: -0.01em;
            background: linear-gradient(135deg, #1a1a2e, #2069E0);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        .panel-header-btns {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .btn-fullscreen {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            border: 1px solid var(--border);
            background: var(--bg-card);
            color: var(--text-secondary);
            font-size: 14px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all var(--transition);
        }
        .btn-fullscreen:hover {
            background: var(--accent);
            color: white;
            border-color: var(--accent);
        }
        .btn-close {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            border: 1px solid var(--border);
            background: var(--bg-card);
            color: var(--text-secondary);
            font-size: 16px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all var(--transition);
        }
        .btn-close:hover {
            background: var(--danger);
            color: white;
            border-color: var(--danger);
        }

        /* ── 工具栏 ── */
        .toolbar {
            padding: 12px 20px;
            border-bottom: 1px solid var(--border);
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
            flex-shrink: 0;
        }
        .toolbar label {
            font-size: 12px;
            color: var(--text-secondary);
        }
        .toolbar input[type="number"] {
            width: 48px;
            padding: 5px 6px;
            border-radius: var(--radius-sm);
            border: 1px solid var(--border);
            background: var(--bg-card);
            color: var(--text-primary);
            font-size: 13px;
            text-align: center;
            outline: none;
            transition: border-color var(--transition);
        }
        .toolbar input[type="number"]:focus {
            border-color: var(--accent);
        }

        .btn {
            padding: 6px 14px;
            border-radius: var(--radius-sm);
            border: none;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: all var(--transition);
            display: inline-flex;
            align-items: center;
            gap: 4px;
        }
        .btn-primary {
            background: linear-gradient(135deg, var(--accent), #4A90F0);
            color: white;
            box-shadow: 0 2px 8px var(--accent-glow);
        }
        .btn-primary:hover {
            box-shadow: 0 4px 16px var(--accent-glow);
            transform: translateY(-1px);
        }
        .btn-secondary {
            background: var(--bg-card);
            color: var(--text-primary);
            border: 1px solid var(--border);
        }
        .btn-secondary:hover {
            background: var(--bg-card-hover);
            border-color: var(--accent);
        }
        .btn-download {
            background: linear-gradient(135deg, var(--success), #00B87A);
            color: white;
            box-shadow: 0 2px 8px rgba(0, 214, 143, 0.3);
        }
        .btn-download:hover {
            box-shadow: 0 4px 16px rgba(0, 214, 143, 0.4);
            transform: translateY(-1px);
        }

        /* ── 进度区域 ── */
        .progress-area {
            padding: 12px 20px;
            border-bottom: 1px solid var(--border);
            flex-shrink: 0;
            display: none;
        }
        .progress-area.active { display: block; }
        .progress-bar-wrap {
            width: 100%;
            height: 6px;
            background: var(--bg-card);
            border-radius: 3px;
            overflow: hidden;
            margin: 8px 0;
        }
        .progress-bar-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--accent), #4A90F0);
            border-radius: 3px;
            width: 0%;
            transition: width 0.3s ease;
        }
        .progress-text {
            font-size: 12px;
            color: var(--text-secondary);
            margin-bottom: 4px;
        }
        .progress-file {
            font-size: 11px;
            color: var(--text-secondary);
            opacity: 0.7;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .zip-area {
            margin-top: 8px;
            display: none;
        }
        .zip-area.active { display: block; }

        /* ── 加载状态 ── */
        .loading {
            padding: 40px 20px;
            text-align: center;
            color: var(--text-secondary);
            display: none;
        }
        .loading.active { display: block; }
        .spinner {
            width: 28px;
            height: 28px;
            border: 3px solid var(--border);
            border-top-color: var(--accent);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin: 0 auto 12px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* ── 文件树 ── */
        .tree-scroll {
            flex: 1;
            overflow-y: auto;
            padding: 12px 16px;
            scrollbar-width: thin;
            scrollbar-color: rgba(0,0,0,0.12) transparent;
        }
        .tree-scroll::-webkit-scrollbar { width: 5px; }
        .tree-scroll::-webkit-scrollbar-track { background: transparent; }
        .tree-scroll::-webkit-scrollbar-thumb {
            background: rgba(0,0,0,0.1);
            border-radius: 3px;
        }

        .tree-node {
            margin-bottom: 1px;
        }
        .tree-row {
            display: flex;
            align-items: center;
            padding: 4px 8px;
            border-radius: var(--radius-sm);
            transition: background var(--transition);
            cursor: pointer;
        }
        .tree-row:hover {
            background: var(--bg-card-hover);
        }
        .tree-row input[type="checkbox"] {
            appearance: none;
            -webkit-appearance: none;
            width: 16px;
            height: 16px;
            border: 1.5px solid rgba(0,0,0,0.2);
            border-radius: 4px;
            background: transparent;
            cursor: pointer;
            flex-shrink: 0;
            margin-right: 8px;
            position: relative;
            transition: all var(--transition);
        }
        .tree-row input[type="checkbox"]:checked {
            background: var(--accent);
            border-color: var(--accent);
        }
        .tree-row input[type="checkbox"]:checked::after {
            content: '';
            position: absolute;
            left: 4px;
            top: 1px;
            width: 5px;
            height: 9px;
            border: solid white;
            border-width: 0 2px 2px 0;
            transform: rotate(45deg);
        }
        .tree-row input[type="checkbox"].indeterminate {
            background: var(--accent);
            border-color: var(--accent);
        }
        .tree-row input[type="checkbox"].indeterminate::after {
            content: '';
            position: absolute;
            left: 3px;
            top: 6px;
            width: 8px;
            height: 2px;
            background: white;
            border-radius: 1px;
        }

        .tree-icon {
            margin-right: 6px;
            font-size: 14px;
            flex-shrink: 0;
        }
        .tree-name {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 13px;
        }
        .tree-name.failed {
            color: var(--danger);
        }
        .tree-name a {
            color: var(--accent);
            text-decoration: none;
            margin-left: 4px;
        }
        .tree-meta {
            font-size: 11px;
            color: var(--text-secondary);
            margin-left: 8px;
            white-space: nowrap;
            flex-shrink: 0;
        }
        .tree-children {
            margin-left: 18px;
        }

        /* ── 空状态 & 错误 ── */
        .empty-state {
            padding: 40px 20px;
            text-align: center;
            color: var(--text-secondary);
        }
        .error-msg {
            padding: 16px 20px;
            color: var(--danger);
            font-size: 13px;
        }

        /* ── 缓存提示条 ── */
        .cache-banner {
            padding: 8px 16px;
            background: rgba(255, 169, 77, 0.12);
            border-bottom: 1px solid rgba(255, 169, 77, 0.25);
            color: var(--warning);
            font-size: 12px;
            display: none;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
        }
        .cache-banner.active {
            display: flex;
        }
        .cache-banner .cache-refresh-link {
            color: var(--warning);
            text-decoration: underline;
            cursor: pointer;
            font-weight: 600;
            margin-left: auto;
        }
        .cache-banner .cache-refresh-link:hover {
            color: #B45309;
        }

        /* ── 下载方式选择器 ── */
        .download-mode-popover {
            position: absolute;
            top: 72px;
            right: 16px;
            width: 280px;
            background: var(--bg-panel);
            border-radius: var(--radius);
            box-shadow: 0 8px 30px rgba(15, 23, 42, 0.25);
            border: 1px solid var(--border);
            padding: 8px 0;
            z-index: 2147483646;
            display: none;
        }
        .download-mode-popover.open {
            display: block;
        }
        .download-mode-option {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            padding: 8px 12px;
            cursor: pointer;
            transition: background var(--transition);
        }
        .download-mode-option:hover {
            background: var(--bg-card-hover);
        }
        .download-mode-option.disabled {
            cursor: not-allowed;
            opacity: 0.55;
        }
        .download-mode-icon {
            font-size: 12px; /* 图标缩小到大约 1/4 面板标题大小 */
            line-height: 1;
            margin-top: 2px;
        }
        .download-mode-text {
            flex: 1;
        }
        .download-mode-title {
            font-size: 13px;
            font-weight: 500;
            margin-bottom: 2px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .download-mode-desc {
            font-size: 11px;
            color: var(--text-secondary);
        }
        .download-mode-recommend {
            display: none;
            font-size: 11px;
            color: #fff;
            background: var(--accent);
            border-radius: 999px;
            padding: 0 6px;
        }
        .download-mode-option.recommended .download-mode-recommend {
            display: inline-block;
        }

        /* ── 下载日志区域 ── */
        .log-panel {
            border-top: 1px solid var(--border);
            background: var(--bg-card);
            flex-shrink: 0;
        }
        .log-header {
            display: flex;
            align-items: center;
            padding: 6px 12px;
            font-size: 12px;
            color: var(--text-secondary);
            cursor: pointer;
            user-select: none;
        }
        .log-header-title {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .log-count {
            font-weight: 600;
            color: var(--accent);
        }
        .log-toggle {
            margin-left: auto;
            font-size: 11px;
        }
        .log-body {
            max-height: 35vh;
            min-height: 0;
            padding: 6px 12px 8px;
            font-size: 11px;
            color: var(--text-secondary);
            overflow-y: auto;
            display: none;
            background: rgba(255,255,255,0.85);
        }
        .log-body.open {
            display: block;
        }
        .log-item {
            display: flex;
            align-items: flex-start;
            gap: 6px;
            margin-bottom: 4px;
        }
        .log-time {
            flex-shrink: 0;
            color: rgba(0,0,0,0.45);
        }
        .log-msg {
            flex: 1;
            word-break: break-all;
        }
        .log-msg.success {
            color: var(--success);
        }
        .log-msg.error {
            color: var(--danger);
        }
        .log-msg.warn {
            color: var(--warning);
        }

        /* ── 响应式 ── */
        @media (max-width: 640px) {
            .panel {
                width: 100vw !important;
                min-width: unset;
            }
            .resize-handle {
                display: none;
            }
            .panel-header {
                padding: 16px 16px 12px;
            }
            .toolbar {
                padding: 10px 16px;
                gap: 6px;
            }
            .tree-scroll {
                padding: 10px 12px;
            }
            .tree-row {
                padding: 6px 8px;
            }
            .tree-meta {
                display: none;
            }
        }

        /* ── FAB 关闭确认对话框 ── */
        .fab-close-dialog {
            position: fixed;
            inset: 0;
            z-index: 2147483647;
            display: none;
            align-items: center;
            justify-content: center;
            background: rgba(0,0,0,0.35);
        }
        .fab-close-dialog.open {
            display: flex;
        }
        .fab-close-dialog-card {
            background: #fff;
            border-radius: 12px;
            padding: 24px;
            width: 280px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.18);
            text-align: center;
        }
        .fab-close-dialog-title {
            font-size: 15px;
            font-weight: 600;
            color: var(--text-primary);
            margin-bottom: 12px;
        }
        .fab-close-dialog-desc {
            font-size: 13px;
            color: var(--text-secondary);
            margin-bottom: 20px;
            line-height: 1.5;
        }
        .fab-close-dialog-actions {
            display: flex;
            gap: 10px;
        }
        .fab-close-dialog-actions button {
            flex: 1;
            padding: 8px 0;
            border: none;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.2s;
        }
        .fab-close-dialog-cancel {
            background: var(--bg-secondary);
            color: var(--text-primary);
        }
        .fab-close-dialog-cancel:hover {
            background: var(--border);
        }
        .fab-close-dialog-confirm {
            background: var(--danger);
            color: #fff;
        }
        .fab-close-dialog-confirm:hover {
            filter: brightness(0.9);
        }

        /* ── 初次使用提示 ── */
        .fab-tooltip {
            position: fixed;
            z-index: 2147483646;
            background: var(--accent);
            color: #fff;
            font-size: 12px;
            padding: 6px 12px;
            border-radius: 6px;
            white-space: nowrap;
            box-shadow: 0 2px 8px rgba(32,105,224,0.3);
            animation: fabTooltipPulse 2s ease-in-out infinite;
            pointer-events: none;
        }
        .fab-tooltip::after {
            content: '';
            position: absolute;
            top: 50%;
            transform: translateY(-50%);
            border: 5px solid transparent;
        }
        .fab-tooltip.arrow-right::after {
            right: -10px;
            border-left-color: var(--accent);
        }
        .fab-tooltip.arrow-left::after {
            left: -10px;
            border-right-color: var(--accent);
        }
        @keyframes fabTooltipPulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.7; }
        }
    `;

    /* ═══════════════════════════════════════════════
     *  UI LAYER — Web Component (extends HTMLElement)
     *  自定义元素 <kdocs-downloader>，Shadow DOM 封装
     * ═══════════════════════════════════════════════ */

    class KDocsUI extends HTMLElement {
        constructor() {
            super();
            this.fileTreeData = null;
            this.failedDownloads = new Set();
            this.isPanelOpen = false;
            this._lastUrl = null; // 记录上次加载数据时的 URL，用于检测目录切换
            this._fabHideTimer = null;
            this._lastProgressText = '';
        }

        connectedCallback() {
            // 元素插入 DOM 时初始化 Shadow DOM 和 UI
            this.host = this; // 元素自身就是宿主
            this.shadow = this.attachShadow({ mode: 'open' });

            const style = document.createElement('style');
            style.textContent = STYLES;
            this.shadow.appendChild(style);

            this._createFAB();
            this._createBackdrop();
            this._createPanel();
            this._bindEvents();

            window.addEventListener('resize', () => this._ensureFabInViewport());
        }

        /* ─── 悬浮球 ─── */

        _createFAB() {
            const fab = document.createElement('div');
            fab.className = 'fab';
            fab.innerHTML = `
                <div class="fab-close" title="关闭悬浮球">×</div>
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/>
                    <polyline points="14 2 14 8 20 8" fill="none" stroke="white" stroke-width="1.5"/>
                    <line x1="16" y1="13" x2="8" y2="13" stroke="white" stroke-width="1.5"/>
                    <line x1="16" y1="17" x2="8" y2="17" stroke="white" stroke-width="1.5"/>
                    <polyline points="10 9 9 9 8 9" fill="none" stroke="white" stroke-width="1.5"/>
                </svg>
            `;

            // 恢复上次位置
            const saved = this._loadPosition();
            fab.style.left = `${saved.x}px`;
            fab.style.top = `${saved.y}px`;

            this.fab = fab;
            this.shadow.appendChild(fab);
            this._initDrag();
            this._initFabAutoHide();
            this._showFirstUseTooltip();
        }

        _loadPosition() {
            try {
                const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    const pos = parsed?.fabPos;
                    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
                        return {
                            x: Utils.clamp(pos.x, 0, window.innerWidth - CONFIG.BALL_SIZE),
                            y: Utils.clamp(pos.y, 0, window.innerHeight - CONFIG.BALL_SIZE),
                        };
                    }
                }
            } catch { }
            return {
                x: window.innerWidth - CONFIG.BALL_SIZE - 20,
                y: window.innerHeight - CONFIG.BALL_SIZE - 80,
            };
        }

        _savePosition(x, y) {
            try {
                const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
                let settings = {};
                try { settings = JSON.parse(raw) || {}; } catch { settings = {}; }
                settings.fabPos = { x, y };
                localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(settings));
            } catch { }
        }

        _getSavedConcurrency() {
            try {
                const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
                if (!raw) return CONFIG.CONCURRENCY_LIMIT;
                const settings = JSON.parse(raw);
                const val = settings?.concurrency;
                if (typeof val === 'number' && Number.isFinite(val)) {
                    return Utils.clamp(Math.round(val), 1, 20);
                }
            } catch { }
            return CONFIG.CONCURRENCY_LIMIT;
        }

        _saveConcurrency(val) {
            const v = Utils.clamp(Math.round(val || CONFIG.CONCURRENCY_LIMIT), 1, 20);
            try {
                const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
                let settings = {};
                if (raw) {
                    try {
                        settings = JSON.parse(raw) || {};
                    } catch {
                        settings = {};
                    }
                }
                settings.concurrency = v;
                localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(settings));
            } catch { }
        }

        _ensureFabInViewport() {
            if (!this.fab) return;
            const rect = this.fab.getBoundingClientRect();
            const x = Utils.clamp(rect.left, 0, window.innerWidth - CONFIG.BALL_SIZE);
            const y = Utils.clamp(rect.top, 0, window.innerHeight - CONFIG.BALL_SIZE);
            this.fab.classList.add('snapping');
            this.fab.style.left = `${x}px`;
            this.fab.style.top = `${y}px`;
            this._savePosition(x, y);
        }

        /**
         * 悬浮球自动半隐藏：
         * - 吸附到左右边缘后，3 秒无操作则只露出半个圆
         * - hover / 面板打开时恢复为完整圆形
         */
        _initFabAutoHide() {
            if (!this.fab) return;
            // 首次调用时绑定事件（只绑定一次）
            if (!this._fabEventsInitialized) {
                this._fabEventsInitialized = true;

                this.fab.addEventListener('mouseenter', () => {
                    if (this._fabHideTimer) {
                        clearTimeout(this._fabHideTimer);
                        this._fabHideTimer = null;
                    }
                    this.fab.classList.remove('half-hidden');
                });
                this.fab.addEventListener('mouseleave', () => {
                    this._startFabHideTimer();
                });

                const closeBtn = this.fab.querySelector('.fab-close');
                if (closeBtn) {
                    closeBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        const CLOSE_KEY = 'kdocs-downloader:ui:close-confirmed';
                        try {
                            if (localStorage.getItem(CLOSE_KEY)) {
                                // 已经确认过一次，直接隐藏
                                this.host.style.display = 'none';
                                return;
                            }
                        } catch { }
                        this._showFabCloseDialog();
                    });
                }
            }
            // 启动自动隐藏计时
            this._startFabHideTimer();
        }

        /** 启动 FAB 半隐藏计时器（可重复调用，安全） */
        _startFabHideTimer() {
            if (this._fabHideTimer) {
                clearTimeout(this._fabHideTimer);
                this._fabHideTimer = null;
            }
            this.fab.classList.remove('half-hidden');
            if (this.isPanelOpen) return;
            this._fabHideTimer = setTimeout(() => {
                if (this.isPanelOpen) return;
                const rect = this.fab.getBoundingClientRect();
                const centerX = rect.left + CONFIG.BALL_SIZE / 2;
                const side = centerX < window.innerWidth / 2 ? 'left' : 'right';
                this.fab.classList.remove('left', 'right');
                this.fab.classList.add(side, 'half-hidden');
            }, 3000);
        }

        /** 显示自定义关闭确认对话框（替代 window.confirm 避免事件重入） */
        _showFabCloseDialog() {
            // 如果已有对话框，先移除
            const existing = this.shadow.querySelector('.fab-close-dialog');
            if (existing) existing.remove();

            const dialog = document.createElement('div');
            dialog.className = 'fab-close-dialog open';
            dialog.innerHTML = `
                <div class="fab-close-dialog-card">
                    <div class="fab-close-dialog-title">隐藏下载助手</div>
                    <div class="fab-close-dialog-desc">悬浮球将隐藏，刷新页面后可重新显示。</div>
                    <div class="fab-close-dialog-actions">
                        <button class="fab-close-dialog-cancel">取消</button>
                        <button class="fab-close-dialog-confirm">隐藏</button>
                    </div>
                </div>
            `;
            this.shadow.appendChild(dialog);

            dialog.querySelector('.fab-close-dialog-cancel').addEventListener('click', () => {
                dialog.remove();
            });
            dialog.querySelector('.fab-close-dialog-confirm').addEventListener('click', () => {
                dialog.remove();
                try { localStorage.setItem('kdocs-downloader:ui:close-confirmed', '1'); } catch { }
                this.host.style.display = 'none';
            });
            // 点击蒙层也关闭
            dialog.addEventListener('click', (e) => {
                if (e.target === dialog) dialog.remove();
            });
        }

        /** 初次使用提示：在 FAB 旁边显示引导气泡 */
        _showFirstUseTooltip() {
            const TOOLTIP_KEY = 'kdocs-downloader:ui:tooltip-shown';
            try {
                if (localStorage.getItem(TOOLTIP_KEY)) return;
            } catch { return; }

            const tip = document.createElement('div');
            tip.className = 'fab-tooltip';
            tip.textContent = '👆 点击打开批量下载助手';
            this.shadow.appendChild(tip);

            const positionTooltip = () => {
                const rect = this.fab.getBoundingClientRect();
                const centerX = rect.left + CONFIG.BALL_SIZE / 2;
                const isRight = centerX >= window.innerWidth / 2;
                tip.classList.remove('arrow-left', 'arrow-right');
                if (isRight) {
                    tip.classList.add('arrow-right');
                    tip.style.top = `${rect.top + CONFIG.BALL_SIZE / 2 - 14}px`;
                    tip.style.left = `${rect.left - tip.offsetWidth - 14}px`;
                } else {
                    tip.classList.add('arrow-left');
                    tip.style.top = `${rect.top + CONFIG.BALL_SIZE / 2 - 14}px`;
                    tip.style.left = `${rect.right + 14}px`;
                }
            };

            // 延迟定位，等待 FAB snap 动画完成
            setTimeout(positionTooltip, 400);

            // 点击 FAB 后移除提示
            const dismiss = () => {
                tip.remove();
                try { localStorage.setItem(TOOLTIP_KEY, '1'); } catch { }
                this.fab.removeEventListener('pointerdown', dismiss);
            };
            this.fab.addEventListener('pointerdown', dismiss);

            // 5 秒后自动消失
            setTimeout(() => {
                if (tip.parentNode) tip.remove();
            }, 5000);
        }


        _initDrag() {
            let startX, startY, offsetX, offsetY, dragging = false, moved = false;

            const onDown = (e) => {
                // 点击关闭按钮时不触发拖拽/点击逻辑
                if (e.target && e.target.closest && e.target.closest('.fab-close')) {
                    return;
                }
                e.preventDefault();
                const rect = this.fab.getBoundingClientRect();
                startX = e.clientX;
                startY = e.clientY;
                offsetX = e.clientX - rect.left;
                offsetY = e.clientY - rect.top;
                dragging = true;
                moved = false;
                this.fab.classList.remove('snapping');
                try { this.fab.setPointerCapture(e.pointerId); } catch { }
            };

            const onMove = (e) => {
                if (!dragging) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                if (Math.abs(dx) > CONFIG.DRAG_THRESHOLD || Math.abs(dy) > CONFIG.DRAG_THRESHOLD) {
                    moved = true;
                }
                if (!moved) return;

                const x = Utils.clamp(e.clientX - offsetX, 0, window.innerWidth - CONFIG.BALL_SIZE);
                const y = Utils.clamp(e.clientY - offsetY, 0, window.innerHeight - CONFIG.BALL_SIZE);
                this.fab.style.left = `${x}px`;
                this.fab.style.top = `${y}px`;
            };

            const onUp = (e) => {
                if (!dragging) return;
                dragging = false;
                try { this.fab.releasePointerCapture(e.pointerId); } catch { }

                if (moved) {
                    // 拖拽结束 → 吸附到最近的左/右边缘
                    const rect = this.fab.getBoundingClientRect();
                    const centerX = rect.left + CONFIG.BALL_SIZE / 2;
                    const snapLeft = centerX < window.innerWidth / 2;
                    const snapX = snapLeft
                        ? 0
                        : window.innerWidth - CONFIG.BALL_SIZE;
                    const snapY = Utils.clamp(rect.top, 8, window.innerHeight - CONFIG.BALL_SIZE - 8);

                    this.fab.classList.add('snapping');
                    this.fab.classList.remove('half-hidden', 'left', 'right');
                    this.fab.style.left = `${snapX}px`;
                    this.fab.style.top = `${snapY}px`;
                    this._savePosition(snapX, snapY);
                }
                // 非拖拽的点击由 click 事件处理
            };

            // 使用 click 事件处理点击打开面板（在桌面和移动端都能可靠触发）
            this.fab.addEventListener('click', (e) => {
                if (moved) return; // 刚拖拽完毕，不打开面板
                if (this.isPanelOpen) return; // 面板已打开时不再响应
                if (e.target && e.target.closest && e.target.closest('.fab-close')) return;
                // 半隐藏状态下先恢复完整显示（移动端无 hover）
                if (this.fab.classList.contains('half-hidden')) {
                    this._startFabHideTimer();
                    return;
                }
                this.togglePanel();
            });

            this.fab.addEventListener('pointerdown', onDown);
            this.fab.addEventListener('pointermove', onMove);
            this.fab.addEventListener('pointerup', onUp);
        }

        /* ─── 遮罩 ─── */

        _createBackdrop() {
            this.backdrop = document.createElement('div');
            this.backdrop.className = 'backdrop';
            this.shadow.appendChild(this.backdrop);
        }

        /* ─── 面板 ─── */

        _createPanel() {
            const panel = document.createElement('div');
            panel.className = 'panel';

            panel.innerHTML = `
                <!-- Header -->
                <div class="panel-header">
                    <span class="panel-title">📥 KDocs 批量下载</span>
                    <div class="panel-header-btns">
                        <button class="btn-fullscreen" title="全屏 / 还原">⛶</button>
                        <button class="btn-close" title="关闭">✕</button>
                    </div>
                </div>

                <!-- Resize handle -->
                <div class="resize-handle"></div>

                <!-- Toolbar -->
                <div class="toolbar">
                    <label>并发数</label>
                    <input type="number" class="input-concurrency" min="1" max="20" value="${CONFIG.CONCURRENCY_LIMIT}">
                    <button class="btn btn-secondary btn-select-all">全选</button>
                    <button class="btn btn-secondary btn-refresh" title="清除缓存并重新加载文件列表">🔄 刷新</button>
                    <button class="btn btn-download btn-do-download" style="display:none">⬇ 下载选中</button>
                </div>

                <!-- Cache banner -->
                <div class="cache-banner">
                    <span>⚠️ 本列表来自缓存（<span class="cache-time"></span>），可能与当前目录不同步</span>
                    <span class="cache-refresh-link">立即刷新</span>
                </div>

                <!-- Progress -->
                <div class="progress-area">
                    <div class="progress-text"></div>
                    <div class="progress-bar-wrap"><div class="progress-bar-fill"></div></div>
                    <div class="progress-file"></div>
                    <div class="zip-area">
                        <div class="progress-text zip-text"></div>
                        <div class="progress-bar-wrap"><div class="progress-bar-fill zip-fill"></div></div>
                    </div>
                </div>

                <!-- Loading -->
                <div class="loading">
                    <div class="spinner"></div>
                    <div class="loading-text">正在加载文件列表...</div>
                </div>

                <!-- File tree -->
                <div class="tree-scroll"></div>

                <!-- Download mode selector -->
                <div class="download-mode-popover">
                    <div class="download-mode-option" data-mode="dir">
                        <span class="download-mode-icon">📂</span>
                        <div class="download-mode-text">
                            <div class="download-mode-title">
                                文件夹批量下载
                                <span class="download-mode-recommend">推荐</span>
                            </div>
                            <div class="download-mode-desc">使用文件系统 API 将所有选中的文件保存到本地文件夹</div>
                        </div>
                    </div>
                    <div class="download-mode-option" data-mode="single">
                        <span class="download-mode-icon">💾</span>
                        <div class="download-mode-text">
                            <div class="download-mode-title">
                                单文件另存为
                                <span class="download-mode-recommend">推荐</span>
                            </div>
                            <div class="download-mode-desc">仅在选中 1 个文件且浏览器支持时可用</div>
                        </div>
                    </div>
                    <div class="download-mode-option" data-mode="browser">
                        <span class="download-mode-icon">🌐</span>
                        <div class="download-mode-text">
                            <div class="download-mode-title">
                                浏览器逐个下载
                                <span class="download-mode-recommend">推荐</span>
                            </div>
                            <div class="download-mode-desc">不使用文件系统 API，直接通过浏览器下载多个文件</div>
                        </div>
                    </div>
                    <div class="download-mode-option" data-mode="zip">
                        <span class="download-mode-icon">📦</span>
                        <div class="download-mode-text">
                            <div class="download-mode-title">
                                ZIP 打包下载
                                <span class="download-mode-recommend">推荐</span>
                            </div>
                            <div class="download-mode-desc">将所有选中文件打包成 ZIP 后一次性下载</div>
                        </div>
                    </div>
                </div>

                <!-- Download logs -->
                <div class="log-panel">
                    <div class="log-header">
                        <div class="log-header-title">
                            <span>📋 下载日志</span>
                            <span class="log-count">(0)</span>
                        </div>
                        <span class="log-toggle">展开</span>
                    </div>
                    <div class="log-body"></div>
                </div>
            `;

            this.panel = panel;
            this.shadow.appendChild(panel);

            // 缓存 DOM 引用
            this.els = {
                closeBtn: panel.querySelector('.btn-close'),
                fullscreenBtn: panel.querySelector('.btn-fullscreen'),
                resizeHandle: panel.querySelector('.resize-handle'),
                concurrencyInput: panel.querySelector('.input-concurrency'),
                selectAllBtn: panel.querySelector('.btn-select-all'),
                refreshBtn: panel.querySelector('.btn-refresh'),
                downloadBtn: panel.querySelector('.btn-do-download'),
                cacheBanner: panel.querySelector('.cache-banner'),
                cacheTime: panel.querySelector('.cache-time'),
                cacheRefreshLink: panel.querySelector('.cache-refresh-link'),
                progressArea: panel.querySelector('.progress-area'),
                progressText: panel.querySelector('.progress-area > .progress-text'),
                progressFill: panel.querySelector('.progress-area > .progress-bar-wrap > .progress-bar-fill'),
                progressFile: panel.querySelector('.progress-file'),
                zipArea: panel.querySelector('.zip-area'),
                zipText: panel.querySelector('.zip-text'),
                zipFill: panel.querySelector('.zip-fill'),
                loading: panel.querySelector('.loading'),
                loadingText: panel.querySelector('.loading-text'),
                treeScroll: panel.querySelector('.tree-scroll'),
                logPanel: panel.querySelector('.log-panel'),
                logBody: panel.querySelector('.log-body'),
                logCount: panel.querySelector('.log-count'),
                logToggle: panel.querySelector('.log-toggle'),
            };

            // 初始化并发数
            const savedConcurrency = this._getSavedConcurrency();
            this.els.concurrencyInput.value = savedConcurrency.toString();
        }

        /* ─── 事件绑定 ─── */

        _bindEvents() {
            this.els.closeBtn.addEventListener('click', () => this.togglePanel(false));
            this.backdrop.addEventListener('click', () => this.togglePanel(false));

            // 全屏切换
            this.els.fullscreenBtn.addEventListener('click', () => {
                this.panel.classList.toggle('fullscreen');
                const isFs = this.panel.classList.contains('fullscreen');
                this.els.fullscreenBtn.textContent = isFs ? '❐' : '⛶';
                this.els.fullscreenBtn.title = isFs ? '还原' : '全屏';
            });

            // 拖拽调整宽度
            this._initResize();

            this.els.selectAllBtn.addEventListener('click', () => {
                if (!this.fileTreeData) return;
                const newState = !TreeModel.isAllSelected(this.fileTreeData);
                TreeModel.setSelection(this.fileTreeData, newState);
                this._renderTree();
            });

            this.els.downloadBtn.addEventListener('click', () => this._showDownloadModeSelector());

            this.els.concurrencyInput.addEventListener('change', () => {
                const val = parseInt(this.els.concurrencyInput.value, 10);
                const clamped = Utils.clamp(Number.isFinite(val) ? val : CONFIG.CONCURRENCY_LIMIT, 1, 20);
                this.els.concurrencyInput.value = clamped.toString();
                this._saveConcurrency(clamped);
            });

            const doRefresh = () => {
                CacheService.clear();
                this.fileTreeData = null;
                this._fetchAndRender();
            };
            this.els.refreshBtn.addEventListener('click', doRefresh);
            this.els.cacheRefreshLink.addEventListener('click', doRefresh);
            this.els.logHeaderClick = () => {
                const isOpen = this.els.logBody.classList.toggle('open');
                this.els.logToggle.textContent = isOpen ? '收起' : '展开';
            };
            this.els.logPanel.querySelector('.log-header').addEventListener('click', this.els.logHeaderClick);

            // 点击面板空白处时关闭下载方式选择器
            this.panel.addEventListener('click', (e) => {
                const target = e.target;
                const pop = this.panel.querySelector('.download-mode-popover');
                if (!pop) return;
                if (pop.contains(target) || this.els.downloadBtn.contains(target)) return;
                pop.classList.remove('open');
            });

            // 一次性绑定下载模式选项的点击事件（避免每次打开 popover 都叠加监听器）
            this._bindDownloadModeOptions();
        }

        _getSelectedFiles() {
            if (!this.fileTreeData) return [];
            return TreeModel.getSelectedFiles(this.fileTreeData);
        }

        /** 一次性绑定下载模式选项的点击事件 */
        _bindDownloadModeOptions() {
            const pop = this.panel.querySelector('.download-mode-popover');
            if (!pop) return;

            const modes = ['dir', 'single', 'browser', 'zip'];
            for (const mode of modes) {
                const el = pop.querySelector(`[data-mode="${mode}"]`);
                if (!el) continue;
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    if (el.classList.contains('disabled')) return;
                    pop.classList.remove('open');
                    this._handleDownload(mode);
                });
            }
        }

        _showDownloadModeSelector() {
            const selectedFiles = this._getSelectedFiles();
            if (!selectedFiles.length) {
                alert('请先选择要下载的文件');
                return;
            }
            const pop = this.panel.querySelector('.download-mode-popover');
            if (!pop) {
                this._handleDownload(); // 兜底：如果 popover 未渲染，走旧逻辑
                return;
            }

            const singleOnly = selectedFiles.length === 1;
            const supportDir = 'showDirectoryPicker' in window;
            const supportSave = 'showSaveFilePicker' in window && singleOnly;

            const optDir = pop.querySelector('[data-mode="dir"]');
            const optSingle = pop.querySelector('[data-mode="single"]');
            const optBrowser = pop.querySelector('[data-mode="browser"]');
            const optZip = pop.querySelector('[data-mode="zip"]');

            const setDisabled = (el, disabled, reason) => {
                if (!el) return;
                if (disabled) {
                    el.classList.add('disabled');
                    if (reason) el.setAttribute('title', reason);
                } else {
                    el.classList.remove('disabled');
                    el.removeAttribute('title');
                }
            };

            setDisabled(optDir, !supportDir, '当前浏览器不支持 File System API，无法批量保存到文件夹');
            setDisabled(optSingle, !supportSave, singleOnly ? '当前浏览器不支持 File System API' : '仅在选中 1 个文件时可用');
            setDisabled(optBrowser, false);
            setDisabled(optZip, false);

            // 根据环境和选择情况设置“推荐”标签
            const allOptions = [optDir, optSingle, optBrowser, optZip];
            allOptions.forEach(opt => opt && opt.classList.remove('recommended'));
            let recommended = null;
            if (!supportDir && !supportSave) {
                recommended = optZip;
            } else if (singleOnly && supportSave) {
                recommended = optSingle;
            } else if (supportDir) {
                recommended = optDir;
            } else {
                recommended = optZip;
            }
            if (recommended && !recommended.classList.contains('disabled')) {
                recommended.classList.add('recommended');
            }

            pop.classList.toggle('open');
        }

        /* ─── 拖拽调整宽度 ─── */

        _initResize() {
            const handle = this.els.resizeHandle;
            let startX, startWidth;

            const onMouseDown = (e) => {
                e.preventDefault();
                startX = e.clientX;
                startWidth = this.panel.offsetWidth;
                handle.classList.add('active');
                // 拖拽期间禁用过渡动画
                this.panel.style.transition = 'none';
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            };

            const onMouseMove = (e) => {
                // 句柄在左侧，向左拖 = 变宽
                const delta = startX - e.clientX;
                const newWidth = Math.max(320, Math.min(window.innerWidth, startWidth + delta));
                this.panel.style.width = `${newWidth}px`;
                // 如果拖到全屏，自动切换全屏状态
                this.panel.classList.toggle('fullscreen', newWidth >= window.innerWidth - 20);
            };

            const onMouseUp = () => {
                handle.classList.remove('active');
                this.panel.style.transition = '';
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                const isFs = this.panel.classList.contains('fullscreen');
                this.els.fullscreenBtn.textContent = isFs ? '❐' : '⛶';
                this.els.fullscreenBtn.title = isFs ? '还原' : '全屏';
            };

            handle.addEventListener('mousedown', onMouseDown);
        }

        /* ─── 面板开关 ─── */

        togglePanel(force) {
            this.isPanelOpen = force !== undefined ? force : !this.isPanelOpen;
            this.panel.classList.toggle('open', this.isPanelOpen);
            this.backdrop.classList.toggle('open', this.isPanelOpen);

            if (this.fab) {
                this.fab.classList.remove('half-hidden');
                // 打开面板时隐藏 FAB，关闭时显示
                this.fab.classList.toggle('hidden', this.isPanelOpen);
            }

            if (this.isPanelOpen) {
                const currentUrl = window.location.href;
                // 首次打开 或 URL 变化（用户切换了目录）时重新加载
                if (!this.fileTreeData || this._lastUrl !== currentUrl) {
                    this._lastUrl = currentUrl;
                    this.fileTreeData = null;
                    this._fetchAndRender();
                } else {
                    // 复用已加载的数据，如果上次加载曾命中缓存则显示提示
                    if (this._lastLoadUsedCache && this._lastFetchTime) {
                        this.els.cacheTime.textContent = this._lastFetchTime;
                        this.els.cacheBanner.classList.add('active');
                    }
                }
            } else {
                // 面板关闭后允许 FAB 再次自动半隐藏
                this._initFabAutoHide();
            }
        }

        /* ─── 数据加载 ─── */

        async _fetchAndRender() {
            this.els.treeScroll.innerHTML = '';
            this.els.downloadBtn.style.display = 'none';
            this.els.progressArea.classList.remove('active');
            this.els.cacheBanner.classList.remove('active');
            this.els.loading.classList.add('active');

            // 重置命中计数器，加载后检查是否命中了缓存
            CacheService.resetHits();

            try {
                const pageInfo = parsePageUrl();
                this.fileTreeData = await initRootAndFetch(pageInfo);
                this.els.loadingText.textContent = '正在加载文件列表...';
                await DataService.processFolderStack(this.fileTreeData, (processedFolders, discoveredFiles) => {
                    this.els.loadingText.textContent = `正在加载文件列表... 已扫描 ${processedFolders} 个文件夹，发现 ${discoveredFiles} 个文件`;
                });
                TreeModel.setSelection(this.fileTreeData, false);
                this._renderTree();
                this.els.downloadBtn.style.display = 'inline-flex';
                // 记录本轮是否命中缓存
                this._lastLoadUsedCache = CacheService.hits > 0;
                this._lastFetchTime = new Date().toLocaleTimeString();
                // 如果本轮加载命中了缓存，立即显示 banner
                if (this._lastLoadUsedCache) {
                    this.els.cacheTime.textContent = this._lastFetchTime;
                    this.els.cacheBanner.classList.add('active');
                }
            } catch (error) {
                console.error('[KDocs] 获取文件列表失败:', error);
                this.els.treeScroll.innerHTML = `<div class="error-msg">获取文件列表失败: ${error.message}</div>`;
            } finally {
                this.els.loading.classList.remove('active');
            }
        }

        /* ─── 文件树渲染 ─── */

        _renderTree() {
            this.els.treeScroll.innerHTML = '';
            if (!this.fileTreeData) return;

            TreeModel.updateCheckboxStates(this.fileTreeData);

            const fragment = document.createDocumentFragment();
            fragment.appendChild(this._createTreeNode(this.fileTreeData));
            this.els.treeScroll.appendChild(fragment);
        }

        _createTreeNode(node) {
            const wrap = document.createElement('div');
            wrap.className = 'tree-node';

            const row = document.createElement('div');
            row.className = 'tree-row';

            // Checkbox
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = node.checked === true;
            if (node.checked === CHECK_STATE.INDETERMINATE) cb.classList.add('indeterminate');

            cb.addEventListener('change', () => {
                if (node.type === NODE_TYPE.FOLDER && TreeModel.isAllSelected(node)) {
                    TreeModel.setSelection(node, false);
                } else {
                    node.checked = cb.checked;
                    if (node.type === NODE_TYPE.FOLDER && cb.checked) {
                        TreeModel.setSelection(node, true);
                    }
                }
                this._renderTree();
            });

            // Icon
            const icon = document.createElement('span');
            icon.className = 'tree-icon';
            icon.textContent = node.type === NODE_TYPE.FOLDER ? '📁' : '📄';

            // Name
            const nameSpan = document.createElement('span');
            nameSpan.className = 'tree-name';
            nameSpan.textContent = node.name;
            nameSpan.title = node.name; // hover 显示完整名称

            if (this.failedDownloads.has(node.id)) {
                nameSpan.classList.add('failed');
                nameSpan.textContent += ' (下载失败)';
            }

            if (node.type !== NODE_TYPE.FOLDER && node.linkUrl) {
                const link = document.createElement('a');
                link.href = node.linkUrl;
                link.textContent = '🔗';
                link.target = '_blank';
                link.addEventListener('click', e => e.stopPropagation());
                nameSpan.appendChild(link);
            }

            // Meta info
            const meta = document.createElement('span');
            meta.className = 'tree-meta';
            if (node.type === NODE_TYPE.FOLDER) {
                meta.textContent = node.mtime ? node.mtime : '';
            } else {
                const size = Utils.formatFileSize(node.size);
                const time = node.mtime || '未知';
                meta.textContent = `${size} · ${time}`;
            }

            row.append(cb, icon, nameSpan, meta);
            wrap.appendChild(row);

            // Row click toggles checkbox (except when clicking on the checkbox itself)
            row.addEventListener('click', (e) => {
                if (e.target === cb) return;
                cb.checked = !cb.checked;
                cb.dispatchEvent(new Event('change'));
            });

            // Children
            if (node.children?.length) {
                const childWrap = document.createElement('div');
                childWrap.className = 'tree-children';
                for (const child of node.children) {
                    childWrap.appendChild(this._createTreeNode(child));
                }
                wrap.appendChild(childWrap);
            }

            return wrap;
        }

        /* ─── 日志区域（统一下载日志出口） ─── */

        _clearLogs() {
            if (!this.els?.logBody) return;
            this.els.logBody.innerHTML = '';
            this.els.logCount.textContent = '(0)';
            this._logCount = 0;
        }

        _appendLog(entry) {
            if (!this.els?.logBody) return;
            const now = new Date();
            const timeStr = now.toLocaleTimeString();
            const level = entry.level || 'info';
            const msg = entry.message || '';

            const item = document.createElement('div');
            item.className = 'log-item';

            const t = document.createElement('span');
            t.className = 'log-time';
            t.textContent = timeStr;

            const m = document.createElement('span');
            m.className = 'log-msg';
            if (level === 'success') m.classList.add('success');
            if (level === 'error') m.classList.add('error');
            if (level === 'warn') m.classList.add('warn');
            m.textContent = msg;

            item.appendChild(t);
            item.appendChild(m);

            this.els.logBody.appendChild(item);
            this._logCount = (this._logCount || 0) + 1;
            this.els.logCount.textContent = `(${this._logCount})`;

            // 自动滚动到最底部
            if (this.els.logBody.classList.contains('open')) {
                this.els.logBody.scrollTop = this.els.logBody.scrollHeight;
            }
        }

        /* ─── 下载处理 ─── */

        async _handleDownload(mode) {
            if (!this.fileTreeData) return;

            const selectedFiles = TreeModel.getSelectedFiles(this.fileTreeData);
            if (selectedFiles.length === 0) {
                alert('请先选择要下载的文件');
                return;
            }

            const concurrency = parseInt(this.els.concurrencyInput.value) || CONFIG.CONCURRENCY_LIMIT;
            this.failedDownloads = new Set();
            this._clearLogs();

            const ui = {
                showProgress: (text, pct) => {
                    this.els.progressArea.classList.add('active');
                    this.els.progressText.textContent = text;
                    this.els.progressFill.style.width = `${pct}%`;
                    // 进度区仅更新 UI，不写日志（每个文件/批次由引擎通过 ui.log 单独记录）
                },
                showFileStatus: (text) => {
                    this.els.progressFile.textContent = text;
                    // 仅更新 UI，不写日志（每个文件由引擎通过 ui.log 单独记录）
                },
                showZipProgress: (text, pct) => {
                    this.els.zipArea.classList.add('active');
                    this.els.zipText.textContent = text;
                    this.els.zipFill.style.width = `${pct}%`;
                    // 仅更新 UI，不写日志
                },
                log: (entry) => this._appendLog(entry),
            };

            const actualMode = mode || (() => {
                if (selectedFiles.length === 1 && 'showSaveFilePicker' in window) return 'single';
                if ('showDirectoryPicker' in window) return 'dir';
                return 'zip';
            })();

            if (actualMode === 'single') {
                if (!(selectedFiles.length === 1 && 'showSaveFilePicker' in window)) {
                    alert('当前选择或浏览器环境不支持「单文件另存为」，已自动回退为 ZIP 下载。');
                    await DownloadEngine.downloadAndZip(selectedFiles, concurrency, this.failedDownloads, ui);
                } else {
                    try {
                        await DownloadEngine.downloadSingleFile(selectedFiles[0], ui);
                    } catch (e) {
                        if (e?.name === 'AbortError') return;
                        console.error('[KDocs] 单文件保存失败，回退 ZIP:', e);
                        this._appendLog({
                            level: 'error',
                            message: `单文件保存失败，将回退为 ZIP 打包下载。原因：${e?.message || e}`,
                        });
                        await DownloadEngine.downloadAndZip(selectedFiles, concurrency, this.failedDownloads, ui);
                    }
                }
            } else if (actualMode === 'dir') {
                if (!('showDirectoryPicker' in window)) {
                    alert('当前浏览器不支持选择文件夹保存，将自动回退为 ZIP 下载。');
                    await DownloadEngine.downloadAndZip(selectedFiles, concurrency, this.failedDownloads, ui);
                } else {
                    if (this._dirPickerActive) {
                        alert('已有一个文件夹选择对话框正在打开，请先处理该对话框后再重试。');
                        return;
                    }
                    try {
                        this._dirPickerActive = true;
                        const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
                        await DownloadEngine.downloadToDirectory(selectedFiles, concurrency, dirHandle, this.failedDownloads, ui);
                    } catch (e) {
                        if (e?.name === 'AbortError') {
                            // 用户主动取消，不回退 ZIP
                            return;
                        }
                        const msg = String(e?.message || e || '');
                        if (/File picker already active/i.test(msg)) {
                            console.warn('[KDocs] showDirectoryPicker 已在进行中，忽略本次重复调用。', e);
                            this._appendLog({
                                level: 'warn',
                                message: '已有一个文件夹选择对话框正在打开，请关闭后再尝试重新开始下载。',
                            });
                            return;
                        }
                        console.error('[KDocs] 目录保存失败，回退 ZIP:', e);
                        this._appendLog({
                            level: 'error',
                            message: `批量保存到文件夹失败，将回退为 ZIP 打包下载。原因：${e?.message || e}`,
                        });
                        await DownloadEngine.downloadAndZip(selectedFiles, concurrency, this.failedDownloads, ui);
                    } finally {
                        this._dirPickerActive = false;
                    }
                }
            } else if (actualMode === 'browser') {
                if (selectedFiles.length > 1) {
                    alert('注意：浏览器可能会弹出「允许下载多个文件」的权限提示，请点击「允许」以确保所有文件能正常下载。');
                }
                await DownloadEngine.downloadViaBrowser(selectedFiles, concurrency, ui);
            } else {
                await DownloadEngine.downloadAndZip(selectedFiles, concurrency, this.failedDownloads, ui);
            }

            this._renderTree();
        }

        /* ─── 进度 UI 辅助 ─── */

        showProgress(text, percent) {
            this.els.progressArea.classList.add('active');
            this.els.progressText.textContent = text;
            this.els.progressFill.style.width = `${percent}%`;
        }

        showFileStatus(text) {
            this.els.progressFile.textContent = text;
        }

        showZipProgress(text, percent) {
            this.els.zipArea.classList.add('active');
            this.els.zipText.textContent = text;
            this.els.zipFill.style.width = `${percent}%`;
        }
    }

    /* ═══════════════════════════════════════════════
     *  INIT — 启动
     * ═══════════════════════════════════════════════ */

    // 防止重复初始化（脚本可能被注入多次）
    if (window.__KDOCS_DL_INIT__) return;
    window.__KDOCS_DL_INIT__ = true;

    CacheService.purgeExpired();
    const TAG = 'kdocs-downloader';
    if (!customElements.get(TAG)) {
        customElements.define(TAG, KDocsUI);
    }
    document.body.appendChild(document.createElement(TAG));
})();