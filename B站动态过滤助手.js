// ==UserScript==
// @name         B站动态过滤助手
// @namespace    https://github.com/habixz
// @version      1.0.0
// @description  在 B 站动态页中按关注分组和动态类型过滤动态
// @author       habixz
// @match        https://t.bilibili.com/*
// @match        https://space.bilibili.com/*
// @grant        unsafeWindow
// @run-at       document-start
// @license      MIT
// @icon         https://www.bilibili.com/favicon.ico
// @note         修改维护：habixz
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_NAME = 'B站动态过滤助手';
    const STORAGE_KEY = 'bili_dynamic_filter_settings_v1';
    const API = {
        relationTags: 'https://api.bilibili.com/x/relation/tags',
        relationTagUsers: 'https://api.bilibili.com/x/relation/tag',
        feedAll: 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all'
    };
    const CONFIG = {
        groupPageSize: 50,
        groupRequestDelay: 120,
        feedRetryPages: 10,
        feedRefreshRequestWait: 700,
        typeChipMinGap: 12,
        dynamicAuthorCacheLimit: 1500,
        pendingAuthorBatchLimit: 40
    };
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    const TYPE_OPTIONS = [
        // 这里将“纯文动态”和“图文动态”合并为同一个筛选项。
        // 因此界面上只保留一个“图文动态”入口，内部统一复用 image 作为筛选键，
        // 避免继续引入新的存储字段或额外迁移成本。
        { value: 'image', label: '图文' },
        { value: 'video', label: '视频' },
        { value: 'forward', label: '转发图文' },
        { value: 'forwardVideo', label: '转发视频' },
        { value: 'article', label: '专栏/文章' },
        { value: 'live', label: '直播/预约' },
        { value: 'other', label: '其他' }
    ];
    const SELECTORS = {
        dynamicCard: '.bili-dyn-item',
        followFeedToolbarAnchors: ['.bili-dyn-list-tabs', '.bili-dyn-list', 'main'],
        userDynamicToolbarAnchors: ['.bili-dyn-list', '[class*="bili-dyn-list"]'],
        dynamicListContainers: ['.bili-dyn-list', '[class*="bili-dyn-list"]']
    };
    const REGEX = {
        mid: /^[1-9]\d{3,11}$/,
        dynamicId: /^\d{10,}$/
    };
    function createDefaultFilters() {
        return {
            groupId: 'all',
            typeEnabled: {
                image: true,
                video: true,
                article: true,
                forward: true,
                forwardVideo: true,
                live: true,
                other: true
            }
        };
    }

    const state = {
        filters: loadFilters(),
        myUid: null,
        groupOptions: [],
        selectedGroupUids: null,
        groupMembersCache: new Map(),
        dynamicAuthorCache: new Map(),
        authorNameCache: new Map(),
        pendingAuthorBatches: [],
        feedFiltersApplied: false,
        feedGroupLoading: false,
        feedRequestVersion: 0,
        feedRefreshPending: false,
        feedRefreshMaskHeight: 0,
        forceEmptyFilteredFeed: false,
        uiWatcherStarted: false,
        domFilterObserverStarted: false,
        domFilterTimer: 0,
        domFilterNeedsFullScan: false,
        pendingDomFilterCards: new Set(),
        originalFetch: null,
        restoringGroupFilter: false,
        lastFeedRequestAt: 0,
        typeLayoutWatcherBound: false,
        typeLayoutFrameId: 0,
        typeLayoutResizeObserver: null
    };
    const PAGE_ADAPTERS = [
        {
            matches: () => location.hostname === 't.bilibili.com' && !/^\/\d+/.test(location.pathname),
            ensureUiMounted: ensureFeedUiMounted,
            supportsGroupFilter: true
        },
        {
            matches: () => location.hostname === 'space.bilibili.com' && /\/dynamic/.test(location.pathname),
            ensureUiMounted: ensureUserTypeUiMounted,
            supportsGroupFilter: false
        }
    ];

    installFetchInterceptor();
    bootstrapUi();

    function bootstrapUi() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', mountUi, { once: true });
        } else {
            mountUi();
        }
    }

    function mountUi() {
        if (!document.body || state.uiWatcherStarted) {
            return;
        }

        ensureStyle();
        ensureTypeLayoutWatcher();
        ensurePageUiMounted();
        startDomFilterObserver();
        scheduleDomFilterApply();
        state.uiWatcherStarted = true;
    }

    function loadFilters() {
        const defaults = createDefaultFilters();
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                return defaults;
            }
            const parsed = JSON.parse(raw);
            const parsedGroupId = typeof parsed?.groupId === 'string'
                ? parsed.groupId
                : defaults.groupId;
            const parsedTypeEnabled = parsed?.typeEnabled || {};
            return {
                ...defaults,
                groupId: parsedGroupId,
                typeEnabled: {
                    ...defaults.typeEnabled,
                    ...parsedTypeEnabled
                }
            };
        } catch (error) {
            console.warn(`[${SCRIPT_NAME}] 读取设置失败，已回退到默认值`, error);
            return defaults;
        }
    }

    function saveFilters() {
        // 只持久化当前仍然有效的字段，避免历史废弃配置继续残留在本地存储里。
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            groupId: state.filters.groupId,
            typeEnabled: state.filters.typeEnabled
        }));
    }

    function ensureStyle() {
        if (document.getElementById('bili-dynamic-filter-style')) {
            return;
        }

        const style = document.createElement('style');
        style.id = 'bili-dynamic-filter-style';
        style.textContent = `
            .bdf-filter-hidden-by-group,
            .bdf-filter-hidden-by-type {
                display: none !important;
            }
            .bdf-filter-ui {
                margin-bottom: 10px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            .bdf-filter-tab-container {
                background: #ffffff;
                border-radius: 6px;
                padding: 0 10px;
                margin-bottom: 8px;
                display: flex;
                align-items: center;
                height: 48px;
                width: 100%;
                box-sizing: border-box;
                border: 1px solid #f1f2f3;
            }
            .bdf-filter-tab-scroll-area,
            .bdf-filter-type-scroll-area {
                display: flex;
                flex-wrap: nowrap;
                overflow-x: auto;
                align-items: center;
                gap: 0;
                width: 100%;
                scrollbar-width: none;
                -ms-overflow-style: none;
                scroll-behavior: smooth;
            }
            .bdf-filter-tab-scroll-area::-webkit-scrollbar,
            .bdf-filter-type-scroll-area::-webkit-scrollbar {
                display: none;
            }
            .bdf-filter-tab-item {
                position: relative;
                margin-right: 24px;
                font-size: 14px;
                color: #61666d;
                cursor: pointer;
                height: 100%;
                display: flex;
                align-items: center;
                white-space: nowrap;
                flex-shrink: 0;
                transition: color 0.2s;
                user-select: none;
            }
            .bdf-filter-tab-item:hover {
                color: #00aeec;
            }
            .bdf-filter-tab-item.active {
                color: #00aeec;
                font-weight: 600;
            }
            .bdf-filter-filter-list {
                background: #fff;
                border: 1px solid #f1f2f3;
                border-radius: 6px;
                padding: 12px 14px;
            }
            .bdf-filter-type-chip {
                flex-shrink: 0;
                font-size: 13px;
                color: #18191c;
                white-space: nowrap;
            }
            .bdf-filter-type-chip label {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                cursor: pointer;
            }
            #bdf-filter-toast-wrap {
                position: fixed;
                top: 72px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 2147483647;
                display: flex;
                flex-direction: column;
                gap: 8px;
                pointer-events: none;
            }
            .bdf-filter-toast {
                min-width: 220px;
                max-width: min(560px, calc(100vw - 32px));
                padding: 10px 14px;
                border-radius: 12px;
                background: rgba(24, 25, 28, 0.92);
                color: #fff;
                font-size: 13px;
                box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
            }
            .bdf-filter-toast-success {
                background: rgba(30, 122, 67, 0.95);
            }
            .bdf-filter-toast-error {
                background: rgba(196, 48, 66, 0.96);
            }
            .bdf-filter-refresh-mask-host {
                position: relative;
            }
            /* 刷新筛选时，不再额外盖一层可见颜色，而是直接让动态内容本体透明化。
               这样视觉上更像“内容暂时消失”，不会在深色模式下冒出一块突兀的浅色遮罩。 */
            .bdf-filter-refresh-mask-host .bili-dyn-item,
            .bdf-filter-refresh-mask-host .bili-dyn-list__skeleton,
            .bdf-filter-refresh-mask-host .bili-dyn-list__loading {
                opacity: 0 !important;
                transition: opacity 0.12s linear;
            }
            .bdf-filter-refresh-mask {
                position: absolute;
                inset: 0;
                z-index: 8;
                display: flex;
                align-items: center;
                justify-content: center;
                background: transparent;
                border-radius: 12px;
                pointer-events: auto;
            }
            .bdf-filter-refresh-mask[hidden] {
                display: none;
            }
            .bdf-filter-refresh-mask-text {
                display: none;
            }
        `;
        document.head.appendChild(style);
    }

    function ensurePageUiMounted() {
        const adapter = getCurrentPageAdapter();
        if (!adapter) {
            return;
        }
        adapter.ensureUiMounted();
    }

    function ensureFeedUiMounted() {
        if (document.getElementById('bdf-filter-feed-ui')) {
            return;
        }
        const anchor = queryFirst(SELECTORS.followFeedToolbarAnchors);
        if (!anchor) {
            return;
        }
        createFeedUi(anchor);
        syncUiFromState();
        void loadGroupOptionsIfNeeded();
    }

    function ensureUserTypeUiMounted() {
        if (document.getElementById('bdf-filter-user-type-ui')) {
            return;
        }
        // 个人动态页不能再回退到 main/#app。
        // 如果在动态列表真正挂载前就插到页面外层，会出现在顶栏下方整屏宽的位置，
        // 同时还可能被后续渲染出来的 #app 内容覆盖，导致“看得到但点不动”。
        // 因此这里只接受真正的动态列表容器，宁可晚一点挂载，也不要挂错层级。
        const anchor = queryFirst(SELECTORS.userDynamicToolbarAnchors);
        if (!anchor) {
            return;
        }
        createUserTypeUi(anchor);
        syncUiFromState();
    }

    function createFeedUi(anchor) {
        const wrapper = document.createElement('div');
        wrapper.id = 'bdf-filter-feed-ui';
        wrapper.className = 'bdf-filter-ui';
        wrapper.innerHTML = `
            <div id="bdf-filter-group-tabs" class="bdf-filter-tab-container">
                <div class="bdf-filter-tab-scroll-area"></div>
            </div>
            <div class="bdf-filter-filter-list">
                <div class="bdf-filter-type-scroll-area" id="bdf-filter-type-bar"></div>
            </div>
        `;
        if (!anchor?.parentNode) {
            document.body.prepend(wrapper);
        } else {
            anchor.parentNode.insertBefore(wrapper, anchor);
        }
        bindHorizontalWheel(wrapper.querySelector('.bdf-filter-tab-scroll-area'));
        bindHorizontalWheel(wrapper.querySelector('.bdf-filter-type-scroll-area'));
        renderFeedTypeFilters('#bdf-filter-type-bar');
        bindFeedTypeEvents();
        refreshTypeLayoutObservationTargets();
    }

    function createUserTypeUi(anchor) {
        const wrapper = document.createElement('div');
        wrapper.id = 'bdf-filter-user-type-ui';
        wrapper.className = 'bdf-filter-ui';
        wrapper.innerHTML = `
            <div class="bdf-filter-filter-list">
                <div class="bdf-filter-type-scroll-area" id="bdf-filter-user-type-bar"></div>
            </div>
        `;
        if (!anchor) {
            document.body.prepend(wrapper);
        } else {
            // 个人动态页要把过滤栏放进动态列表容器内部顶部，
            // 这样布局宽度、留白和点击层级都会跟随列表列宽，视觉上更接近总动态页。
            anchor.insertBefore(wrapper, anchor.firstChild);
        }
        bindHorizontalWheel(wrapper.querySelector('.bdf-filter-type-scroll-area'));
        renderFeedTypeFilters('#bdf-filter-user-type-bar');
        bindFeedTypeEvents();
        refreshTypeLayoutObservationTargets();
    }

    function bindHorizontalWheel(element) {
        if (!element) {
            return;
        }
        element.addEventListener('wheel', (event) => {
            if (event.deltaY !== 0) {
                event.preventDefault();
                element.scrollLeft += event.deltaY;
            }
        }, { passive: false });
    }

    function ensureTypeLayoutWatcher() {
        if (state.typeLayoutWatcherBound) {
            return;
        }

        // 类型栏的可用宽度会随窗口大小、页面侧栏和站内布局变化而变化。
        // 因此这里统一监听 resize，在尺寸变化后重新计算每个类型栏的 gap，
        // 让“铺满 / 缩间距 / 横向滚动”三段式策略始终成立。
        window.addEventListener('resize', () => {
            scheduleTypeBarLayoutSync();
        });

        // `space` 个人动态页的主列宽度会在首屏异步渲染过程中继续变化，
        // 但这类变化未必会触发 window.resize。
        // 因此这里额外观察类型栏及其外层容器的尺寸变化，
        // 只要列宽稳定到最终值，就立即重新计算一次 gap。
        if (typeof ResizeObserver === 'function') {
            state.typeLayoutResizeObserver = new ResizeObserver(() => {
                scheduleTypeBarLayoutSync();
            });
        }
        state.typeLayoutWatcherBound = true;
    }

    function refreshTypeLayoutObservationTargets() {
        const resizeObserver = state.typeLayoutResizeObserver;
        if (!resizeObserver) {
            return;
        }

        resizeObserver.disconnect();
        document.querySelectorAll('.bdf-filter-type-scroll-area, .bdf-filter-filter-list, .bdf-filter-ui').forEach((element) => {
            if (element instanceof Element) {
                resizeObserver.observe(element);
            }
        });
    }

    function getCurrentPageAdapter() {
        return PAGE_ADAPTERS.find((adapter) => adapter.matches()) || null;
    }

    function supportsCurrentPageGroupFilter() {
        return Boolean(getCurrentPageAdapter()?.supportsGroupFilter);
    }

    function hasActiveGroupFilter() {
        return supportsCurrentPageGroupFilter() && state.feedFiltersApplied && state.filters.groupId !== 'all';
    }

    function resetFeedFilterVisualState() {
        setFeedRefreshPending(false);
        state.forceEmptyFilteredFeed = false;
    }

    function updateGroupFilterState(selectedGroupUids) {
        state.selectedGroupUids = selectedGroupUids;
        state.feedFiltersApplied = supportsCurrentPageGroupFilter() && state.filters.groupId !== 'all';
    }

    const feedFilterController = {
        async resolveCurrentSelection() {
            if (!supportsCurrentPageGroupFilter()) {
                return null;
            }
            return resolveSelectedGroupUids(state.filters.groupId);
        },
        shouldTriggerRefreshAfterChange(hadGroupFilter) {
            // 这里不能只看“旧状态里是否已经有分组过滤生效”，
            // 因为从“全部”首次切到某个分组时，hadGroupFilter 和 hasActiveGroupFilter()
            // 在 applySelection 之前都还是 false，最终会误判为“不需要刷新”。
            // 因此这里直接基于“当前准备应用的新 groupId”来判断本次切换后是否应进入刷新链路。
            const nextGroupFilterActive = supportsCurrentPageGroupFilter() && state.filters.groupId !== 'all';
            return hadGroupFilter || nextGroupFilterActive;
        },
        async applySelection(selectedGroupUids, options = {}) {
            const shouldSaveFilters = options.saveFilters === true;
            const shouldRefresh = options.shouldRefresh === true;

            updateGroupFilterState(selectedGroupUids);
            resetFeedFilterVisualState();

            if (shouldSaveFilters) {
                saveFilters();
            }

            // 过滤状态本身已经发生变化，先安排一次整页重算；
            // 如果后面需要触发刷新链路，新的接口结果返回后还会再次增量/全量修正 DOM。
            scheduleDomFilterApply(true);

            if (shouldRefresh) {
                await this.triggerRefresh();
                return;
            }

            // 当本次变更不需要触发请求级刷新时，仍要立刻把当前 DOM 重算一遍，
            // 避免只依赖异步队列，导致用户点击后短时间内看起来像“没有反应”。
            if (state.domFilterTimer) {
                clearTimeout(state.domFilterTimer);
                state.domFilterTimer = 0;
            }
            applyDomFilters();
        },
        async triggerRefresh() {
            // 统一收口“切请求版本 + 标记刷新中 + 强制重拉列表”这一组动作，
            // 避免多个调用点以后各自再长出一份近似但不完全相同的刷新链路。
            bumpFeedRequestVersion();
            setFeedRefreshPending(true);
            await forceFeedRefresh();
        },
        createRequestContext() {
            const requestFiltersApplied = state.feedFiltersApplied;
            return {
                requestVersion: state.feedRequestVersion,
                requestFiltersApplied,
                requestSelectedGroupUids: requestFiltersApplied && state.selectedGroupUids
                    ? new Set(state.selectedGroupUids)
                    : null
            };
        },
        isCurrentRequestContext(context) {
            return context.requestVersion === state.feedRequestVersion;
        },
        settleRequestUiState(context, options = {}) {
            if (!this.isCurrentRequestContext(context)) {
                return;
            }

            setFeedRefreshPending(false);
            state.forceEmptyFilteredFeed = options.forceEmptyFilteredFeed === true;
        }
    };

    function shouldForceHideAllCardsByGroup(adapter) {
        return Boolean(
            adapter?.supportsGroupFilter
            && hasActiveGroupFilter()
            && (state.feedRefreshPending || state.forceEmptyFilteredFeed)
        );
    }

    function shouldCardPassGroupFilter(authorMid, adapter) {
        if (!adapter?.supportsGroupFilter || !hasActiveGroupFilter() || !state.selectedGroupUids) {
            return true;
        }
        // UID 仍未识别成功时，继续维持“谨慎放行”策略，避免因为解析不到作者而误伤卡片。
        if (!authorMid) {
            return true;
        }
        return state.selectedGroupUids.has(authorMid);
    }

    function shouldShowFeedRefreshMask() {
        return supportsCurrentPageGroupFilter() && state.feedRefreshPending;
    }

    function ensureFeedRefreshMask(container) {
        if (!container) {
            return null;
        }

        let mask = container.querySelector(':scope > .bdf-filter-refresh-mask');
        if (!mask) {
            mask = document.createElement('div');
            mask.className = 'bdf-filter-refresh-mask';
            mask.hidden = true;
            mask.innerHTML = '<div class="bdf-filter-refresh-mask-text">分组切换中…</div>';
            container.appendChild(mask);
        }
        return mask;
    }

    function syncFeedRefreshMask() {
        const listContainer = queryFirst(SELECTORS.dynamicListContainers);
        document.querySelectorAll('.bdf-filter-refresh-mask-host').forEach((container) => {
            if (container !== listContainer) {
                container.classList.remove('bdf-filter-refresh-mask-host');
                container.style.minHeight = '';
                const staleMask = container.querySelector(':scope > .bdf-filter-refresh-mask');
                if (staleMask) {
                    staleMask.remove();
                }
            }
        });

        const container = listContainer;
        if (!container) {
            return;
        }

        const mask = ensureFeedRefreshMask(container);
        if (!mask) {
            return;
        }

        if (shouldShowFeedRefreshMask()) {
            container.classList.add('bdf-filter-refresh-mask-host');
            if (!state.feedRefreshMaskHeight) {
                state.feedRefreshMaskHeight = Math.max(
                    Math.round(container.getBoundingClientRect().height),
                    container.scrollHeight,
                    320
                );
            }
            container.style.minHeight = `${state.feedRefreshMaskHeight}px`;
            mask.hidden = false;
        } else {
            container.classList.remove('bdf-filter-refresh-mask-host');
            mask.hidden = true;
            container.style.minHeight = '';
            state.feedRefreshMaskHeight = 0;
        }
    }

    function setFeedRefreshPending(pending) {
        state.feedRefreshPending = pending;
        if (!pending) {
            state.feedRefreshMaskHeight = 0;
        }
        syncFeedRefreshMask();
    }

    function renderFeedTypeFilters(selector) {
        document.querySelectorAll(selector).forEach((container) => {
            container.innerHTML = TYPE_OPTIONS.map((option) => `
                <div class="bdf-filter-type-chip">
                    <label>
                        <input class="bdf-filter-type-checkbox" data-type="${option.value}" type="checkbox">
                        ${option.label}
                    </label>
                </div>
            `).join('');
        });
        refreshTypeLayoutObservationTargets();
        scheduleTypeBarLayoutSync();
    }

    function bindFeedTypeEvents() {
        document.querySelectorAll('.bdf-filter-type-checkbox').forEach((checkbox) => {
            checkbox.addEventListener('change', () => {
                updateFiltersFromUi();
                saveFilters();
                void applyFeedFilters();
            });
        });
    }

    function scheduleTypeBarLayoutSync() {
        if (state.typeLayoutFrameId) {
            return;
        }

        // 布局读取要等当前渲染批次结束后再做，避免拿到旧宽度或 0 宽度。
        state.typeLayoutFrameId = requestAnimationFrame(() => {
            state.typeLayoutFrameId = 0;
            syncTypeBarLayouts();
        });
    }

    function syncTypeBarLayouts() {
        document.querySelectorAll('.bdf-filter-type-scroll-area').forEach((scrollArea) => {
            syncTypeBarLayout(scrollArea);
        });
    }

    function syncTypeBarLayout(scrollArea) {
        if (!scrollArea) {
            return;
        }

        const chips = Array.from(scrollArea.querySelectorAll('.bdf-filter-type-chip'));
        if (chips.length <= 1) {
            scrollArea.style.gap = '0px';
            return;
        }

        const availableWidth = scrollArea.clientWidth;
        if (!availableWidth) {
            return;
        }

        const contentWidth = chips.reduce((totalWidth, chip) => totalWidth + chip.offsetWidth, 0);
        const gapCount = chips.length - 1;
        const idealGap = (availableWidth - contentWidth) / gapCount;
        const appliedGap = Math.max(CONFIG.typeChipMinGap, idealGap);

        // 这里不缩放元素本身，只改元素之间的 gap：
        // 1. 放得下时，用更大的 gap 把整行铺满；
        // 2. 逐渐变窄时，gap 会跟着收缩；
        // 3. 收缩到最小 gap 后若仍放不下，就交给容器横向滚动。
        scrollArea.style.gap = `${appliedGap}px`;
    }

    function ensureActiveGroupTabFullyVisible(scrollArea) {
        if (!scrollArea) {
            return;
        }

        const activeItem = scrollArea.querySelector('.bdf-filter-tab-item.active');
        if (!activeItem) {
            return;
        }

        // 分组栏每次刷新后都会从最左侧开始显示。
        // 这里不做“居中”，只做“完整显示 + 最小位移”的可见性修正：
        // 1. 如果当前激活项已经完整显示，则完全不滚动；
        // 2. 如果左侧被裁掉，只向左滚到刚好完整显示；
        // 3. 如果右侧被裁掉，只向右滚到刚好完整显示。
        requestAnimationFrame(() => {
            const viewLeft = scrollArea.scrollLeft;
            const viewRight = viewLeft + scrollArea.clientWidth;
            const itemLeft = activeItem.offsetLeft;
            const itemRight = itemLeft + activeItem.offsetWidth;

            if (itemLeft >= viewLeft && itemRight <= viewRight) {
                return;
            }

            if (itemLeft < viewLeft) {
                scrollArea.scrollLeft = itemLeft;
                return;
            }

            if (itemRight > viewRight) {
                scrollArea.scrollLeft = itemRight - scrollArea.clientWidth;
            }
        });
    }

    function renderFeedGroupTabs() {
        const scrollArea = document.querySelector('#bdf-filter-group-tabs .bdf-filter-tab-scroll-area');
        if (!scrollArea) {
            return;
        }

        const tabs = [{ name: '全部', id: 'all' }, ...state.groupOptions.map((group) => ({
            name: group.name || `分组 ${group.tagid}`,
            id: String(group.tagid)
        }))];

        scrollArea.innerHTML = '';
        tabs.forEach((tab) => {
            const item = document.createElement('div');
            item.className = 'bdf-filter-tab-item';
            if (state.filters.groupId === tab.id) {
                item.classList.add('active');
            }
            item.textContent = tab.name;
            item.addEventListener('pointerdown', async (event) => {
                event.preventDefault();
                if (state.feedGroupLoading) {
                    return;
                }
                const previousGroupId = state.filters.groupId;
                if (previousGroupId === tab.id) {
                    return;
                }

                scrollArea.querySelectorAll('.bdf-filter-tab-item').forEach((element) => element.classList.remove('active'));
                item.classList.add('active');
                state.filters.groupId = tab.id;
                saveFilters();
                state.feedGroupLoading = true;

                try {
                    await applyFeedFilters({ previousGroupId });
                } finally {
                    state.feedGroupLoading = false;
                }
            });
            scrollArea.appendChild(item);
        });
        ensureActiveGroupTabFullyVisible(scrollArea);
    }

    function syncUiFromState() {
        document.querySelectorAll('.bdf-filter-type-checkbox').forEach((checkbox) => {
            checkbox.checked = Boolean(state.filters.typeEnabled[checkbox.dataset.type]);
        });
        renderFeedGroupTabs();
    }

    function updateFiltersFromUi() {
        document.querySelectorAll('.bdf-filter-type-checkbox').forEach((checkbox) => {
            state.filters.typeEnabled[checkbox.dataset.type] = checkbox.checked;
        });
    }

    async function loadGroupOptionsIfNeeded() {
        if (!supportsCurrentPageGroupFilter()) {
            return;
        }
        if (state.groupOptions.length === 0) {
            try {
                state.myUid = state.myUid || getMyUidFromCookie();
                if (!state.myUid) {
                    showToast('未检测到登录态，无法读取关注分组。', 'error');
                    return;
                }
                const json = await requestJson(`${API.relationTags}?jsonp=jsonp`);
                state.groupOptions = Array.isArray(json?.data) ? json.data : [];
            } catch (error) {
                console.error(`[${SCRIPT_NAME}] 读取关注分组失败`, error);
                showToast('读取关注分组失败。', 'error');
            }
        }

        renderFeedGroupTabs();
        void restoreSavedGroupFilterIfNeeded();
    }

    async function restoreSavedGroupFilterIfNeeded() {
        if (!supportsCurrentPageGroupFilter() || state.filters.groupId === 'all' || state.restoringGroupFilter) {
            return;
        }
        if (state.selectedGroupUids && hasActiveGroupFilter()) {
            return;
        }

        state.restoringGroupFilter = true;
        try {
            // 分组过滤恢复时直接沿用当前唯一实现的请求级刷新策略，
            // 主动重拉第一页并清掉旧卡片，保证页面与过滤条件强一致。
            await feedFilterController.applySelection(
                await feedFilterController.resolveCurrentSelection(),
                { shouldRefresh: true }
            );
        } catch (error) {
            console.error(`[${SCRIPT_NAME}] 恢复分组过滤失败`, error);
        } finally {
            state.restoringGroupFilter = false;
        }
    }

    async function applyFeedFilters(options = {}) {
        if (!getCurrentPageAdapter()) {
            showToast('当前页面不支持列表过滤。', 'error');
            return;
        }

        updateFiltersFromUi();
        const previousGroupId = typeof options.previousGroupId === 'string'
            ? options.previousGroupId
            : state.filters.groupId;
        // 分组 tab 的点击流程会先把新的 groupId 写进状态。
        // 如果这里再直接看当前状态，就会把“刚从某个分组切回全部”的场景误判成“之前没有分组过滤”，
        // 最终导致请求级刷新链路不触发。
        const hadGroupFilter = supportsCurrentPageGroupFilter()
            && state.feedFiltersApplied
            && previousGroupId !== 'all';

        try {
            const selectedGroupUids = await feedFilterController.resolveCurrentSelection();
            await feedFilterController.applySelection(selectedGroupUids, {
                saveFilters: true,
                shouldRefresh: feedFilterController.shouldTriggerRefreshAfterChange(hadGroupFilter)
            });
        } catch (error) {
            console.error(`[${SCRIPT_NAME}] 读取分组成员失败`, error);
            showToast('读取分组成员失败。', 'error');
        }
    }

    async function resolveSelectedGroupUids(groupId) {
        if (!groupId || groupId === 'all') {
            return null;
        }

        const cacheKey = String(groupId);
        if (state.groupMembersCache.has(cacheKey)) {
            return state.groupMembersCache.get(cacheKey);
        }

        state.myUid = state.myUid || getMyUidFromCookie();
        if (!state.myUid) {
            throw new Error('未检测到登录用户 UID');
        }

        const uidSet = new Set();
        let page = 1;
        while (true) {
            const url = `${API.relationTagUsers}?mid=${encodeURIComponent(state.myUid)}&tagid=${encodeURIComponent(groupId)}&pn=${page}&ps=${CONFIG.groupPageSize}`;
            const json = await requestJson(url);
            if (json?.code !== 0) {
                throw new Error(json?.message || '分组接口返回异常');
            }

            const users = Array.isArray(json?.data) ? json.data : [];
            users.forEach((user) => {
                if (user?.mid) {
                    uidSet.add(String(user.mid));
                }
            });

            if (users.length < CONFIG.groupPageSize) {
                break;
            }
            page += 1;
            await sleep(CONFIG.groupRequestDelay);
        }

        state.groupMembersCache.set(cacheKey, uidSet);
        return uidSet;
    }

    async function forceFeedRefresh() {
        syncFeedRefreshMask();
        clearRenderedDynamicCards();
        const previousFeedRequestAt = state.lastFeedRequestAt;
        const triggered = await triggerNativeFeedRefresh();
        if (triggered) {
            const hasObservedNewRequest = await waitForFeedRequestAfter(previousFeedRequestAt, CONFIG.feedRefreshRequestWait);
            if (hasObservedNewRequest) {
                window.scrollTo({ top: 0, behavior: 'auto' });
                return;
            }
        }

        // 如果原生列表结构变了，点击 tab 可能已经无法触发新的动态流请求。
        // 这时直接整页重载，比停留在“看似刷新但实际没有新请求”的假状态更稳。
        window.location.reload();
    }

    async function triggerNativeFeedRefresh() {
        const tabs = Array.from(document.querySelectorAll('.bili-dyn-list-tabs__item'));
        if (tabs.length < 2) {
            return false;
        }

        // 不再假定第 2 个一定是“视频”。
        // 这里只要求“先切到另一个 tab，再切回当前 tab”，借用站内已有的刷新副作用。
        const activeTab = tabs.find((tab) => tab.classList.contains('active')) || tabs[0];
        const alternateTab = tabs.find((tab) => tab !== activeTab) || null;
        if (!activeTab || !alternateTab) {
            return false;
        }

        alternateTab.click();
        await sleep(120);
        activeTab.click();
        return true;
    }

    async function waitForFeedRequestAfter(previousFeedRequestAt, timeoutMs) {
        const startTime = Date.now();
        while ((Date.now() - startTime) < timeoutMs) {
            if (state.lastFeedRequestAt > previousFeedRequestAt) {
                return true;
            }
            await sleep(40);
        }
        return false;
    }

    function markFeedRequestObserved() {
        state.lastFeedRequestAt = Date.now();
    }

    function bumpFeedRequestVersion() {
        state.feedRequestVersion += 1;
        return state.feedRequestVersion;
    }

    function clearRenderedDynamicCards() {
        // 仅删除已渲染的卡片还不够，切换分组时还要把当前列表里的骨架屏/加载占位一起清掉。
        // 否则 B 站前端后续 patch 旧请求结果时，容易把上一次分组的内容重新挂回列表。
        document.querySelectorAll('.bili-dyn-item, .bili-dyn-list__skeleton, .bili-dyn-list__loading')
            .forEach((node) => node.remove());
    }

    function installFetchInterceptor() {
        const originalFetch = pageWindow.fetch.bind(pageWindow);
        state.originalFetch = originalFetch;

        const patchedFetch = async function patchedFetch(input, init) {
            const url = getRequestUrl(input);
            if (shouldObserveFeedRequest(url) || shouldInterceptFeedRequest(url)) {
                markFeedRequestObserved();
            }
            if (shouldInterceptFeedRequest(url)) {
                return filterFeedResponse(originalFetch, input, init);
            }
            if (shouldObserveFeedRequest(url)) {
                return observeFeedResponse(originalFetch, input, init);
            }
            return originalFetch(input, init);
        };

        pageWindow.fetch = patchedFetch;
        window.fetch = patchedFetch;
    }

    function shouldInterceptFeedRequest(url) {
        if (!url || !supportsCurrentPageGroupFilter()) {
            return false;
        }
        if (!url.includes('/x/polymer/web-dynamic/v1/feed/all')) {
            return false;
        }
        try {
            return !new URL(url, location.href).searchParams.has('host_mid');
        } catch (error) {
            return !url.includes('host_mid=');
        }
    }

    function shouldObserveFeedRequest(url) {
        if (!url || !supportsCurrentPageGroupFilter()) {
            return false;
        }
        if (!url.includes('/x/polymer/web-dynamic/v1/feed/all')) {
            return false;
        }
        try {
            return !new URL(url, location.href).searchParams.has('host_mid');
        } catch (error) {
            return !url.includes('host_mid=');
        }
    }

    async function observeFeedResponse(originalFetch, input, init) {
        const response = await originalFetch(input, init);
        if (!response.ok) {
            return response;
        }

        try {
            const clone = response.clone();
            const json = await clone.json();
            const items = Array.isArray(json?.data?.items) ? json.data.items : null;
            if (items) {
                cacheFeedAuthorData(items);
            }
        } catch (error) {
            // 这里只是旁路收集动态作者映射，不应影响页面原始请求。
        }

        return response;
    }

    async function filterFeedResponse(originalFetch, input, init) {
        try {
            // 在请求发出时拍下当前过滤上下文。
            // 后面即使用户已经切到别的分组，这个请求也必须按“发起当时”的版本来判断是否过期。
            const requestUrl = getRequestUrl(input);
            return filterFeedResponseWithContext(originalFetch, requestUrl, init, feedFilterController.createRequestContext(), 1);
        } catch (error) {
            console.error(`[${SCRIPT_NAME}] 动态流过滤失败`, error);
            setFeedRefreshPending(false);
            return originalFetch(input, init);
        }
    }

    async function filterFeedResponseWithContext(originalFetch, requestUrl, init, context, attempt) {
        const isPaginationRequest = hasFeedRequestOffset(requestUrl);
        const response = await originalFetch(requestUrl, init);
        if (!response.ok) {
            return response;
        }

        const clone = response.clone();
        let json;
        try {
            json = await clone.json();
        } catch (error) {
            return response;
        }

        const items = Array.isArray(json?.data?.items) ? json.data.items : null;
        if (!items) {
            return response;
        }
        cacheFeedAuthorData(items);

        // 只要请求版本已经落后于当前版本，就直接把它变成空结果。
        // 这样旧请求即使最后才返回，也不能把上一个分组的数据沿用到新分组界面。
        if (!feedFilterController.isCurrentRequestContext(context)) {
            return rebuildJsonResponse(response, buildEmptyFeedResponseData(json));
        }

        if (!context.requestFiltersApplied || !context.requestSelectedGroupUids || context.requestSelectedGroupUids.size === 0) {
            feedFilterController.settleRequestUiState(context, { forceEmptyFilteredFeed: false });
            return response;
        }

        const filteredItems = items.filter((item) => matchesGroup(item, context.requestSelectedGroupUids));
        if (filteredItems.length > 0) {
            feedFilterController.settleRequestUiState(context, { forceEmptyFilteredFeed: false });
            json.data.items = filteredItems;
            return rebuildJsonResponse(response, json);
        }

        const nextOffset = String(json?.data?.offset || '');
        const hasMore = Boolean(json?.data?.has_more);
        if (hasMore && nextOffset && attempt < CONFIG.feedRetryPages) {
            return filterFeedResponseWithContext(
                originalFetch,
                constructNextFeedRequestUrl(requestUrl, nextOffset),
                init,
                context,
                attempt + 1
            );
        }

        // 只有首屏刷新在多次向后探测后仍完全无命中时，才需要强制把页面保持为空。
        // 如果是向下滚动触发的翻页链路为空，说明“后续没有更多命中项”，
        // 这时必须保留当前已显示的命中卡片，不能把整页一起清空。
        feedFilterController.settleRequestUiState(context, { forceEmptyFilteredFeed: !isPaginationRequest });
        return rebuildJsonResponse(response, buildEmptyFeedResponseData(json, {
            hasMore: hasMore,
            offset: nextOffset
        }));
    }

    function buildEmptyFeedResponseData(json, options = {}) {
        const nextJson = json && typeof json === 'object' ? json : {};
        const nextData = nextJson.data && typeof nextJson.data === 'object' ? nextJson.data : {};
        const normalizedHasMore = typeof options.hasMore === 'boolean' ? options.hasMore : false;
        const normalizedOffset = typeof options.offset === 'string' ? options.offset : '';

        // 这里显式把动态流相关字段一起归零，避免前端继续沿用上一轮请求保留下来的分页游标和列表状态。
        nextData.items = [];
        nextData.has_more = normalizedHasMore;
        nextData.offset = normalizedOffset;
        nextData.history_offset = '';
        nextData.update_num = 0;
        nextJson.data = nextData;
        return nextJson;
    }

    function constructNextFeedRequestUrl(currentUrl, nextOffset) {
        try {
            const url = new URL(currentUrl, location.href);
            url.searchParams.set('offset', nextOffset);
            return url.toString();
        } catch (error) {
            return currentUrl;
        }
    }

    function hasFeedRequestOffset(url) {
        try {
            const parsed = new URL(url, location.href);
            return Boolean(parsed.searchParams.get('offset'));
        } catch (error) {
            return false;
        }
    }

    function rebuildJsonResponse(sourceResponse, data) {
        return new Response(JSON.stringify(data), {
            status: sourceResponse.status,
            statusText: sourceResponse.statusText,
            headers: new Headers(sourceResponse.headers)
        });
    }

    function cacheFeedAuthorData(items) {
        const batch = [];
        items.forEach((item) => {
            const dynamicId = getItemDynamicId(item);
            const authorMid = String(item?.modules?.module_author?.mid || '');
            const authorName = normalizeAuthorName(item?.modules?.module_author?.name || '');
            if (dynamicId && authorMid) {
                setDynamicAuthorCache(dynamicId, authorMid);
            }
            if (authorName && authorMid) {
                setAuthorNameCache(authorName, authorMid);
            }
            batch.push({
                dynamicId,
                authorMid,
                authorName
            });
        });

        if (batch.length > 0) {
            pushPendingAuthorBatch(batch);
            // 这里在旁路拿到 feed/all 的作者数据后，主动安排一次增量重算，
            // 这样当前列表里的卡片可以尽快补齐作者 UID，并及时应用最新过滤结果。
            scheduleDomFilterApply(false);
        }
    }

    function getItemDynamicId(item) {
        return String(item?.id_str || item?.basic?.id_str || '');
    }

    function matchesGroup(item, selectedGroupUids) {
        if (!selectedGroupUids || selectedGroupUids.size === 0) {
            return true;
        }
        const mid = String(item?.modules?.module_author?.mid || '');
        return selectedGroupUids.has(mid);
    }

    function startDomFilterObserver() {
        if (state.domFilterObserverStarted || !document.body) {
            return;
        }
        const observer = new MutationObserver((mutations) => {
            ensurePageUiMounted();
            let hasDirtyCards = false;
            mutations.forEach((mutation) => {
                hasDirtyCards = markNodeForDomFilter(mutation.target) || hasDirtyCards;
                mutation.addedNodes.forEach((node) => {
                    hasDirtyCards = markNodeForDomFilter(node) || hasDirtyCards;
                });
            });

            if (hasDirtyCards) {
                scheduleDomFilterApply(false);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        state.domFilterObserverStarted = true;
    }

    function scheduleDomFilterApply(forceFullScan = true) {
        state.domFilterNeedsFullScan = state.domFilterNeedsFullScan || forceFullScan;
        if (state.domFilterTimer) {
            clearTimeout(state.domFilterTimer);
        }
        state.domFilterTimer = window.setTimeout(() => {
            state.domFilterTimer = 0;
            applyDomFilters();
        }, 80);
    }

    function applyDomFilters() {
        const adapter = getCurrentPageAdapter();
        if (!adapter) {
            return;
        }

        syncFeedRefreshMask();
        bindPendingAuthorBatchesToCards();
        const cards = getCardsToFilter();
        const shouldForceHideAllByGroup = shouldForceHideAllCardsByGroup(adapter);

        if (cards.length === 0) {
            state.domFilterNeedsFullScan = false;
            state.pendingDomFilterCards.clear();
            return;
        }

        cards.forEach((card) => {
            const authorMid = getCardAuthorMid(card);
            const typeKey = detectDynamicTypeFromCard(card);
            const shouldShowByGroup = shouldForceHideAllByGroup
                ? false
                : shouldCardPassGroupFilter(authorMid, adapter);
            const shouldShowByType = state.filters.typeEnabled[typeKey] !== false;

            card.classList.toggle('bdf-filter-hidden-by-group', !shouldShowByGroup);
            card.classList.toggle('bdf-filter-hidden-by-type', !shouldShowByType);
        });

        state.domFilterNeedsFullScan = false;
        state.pendingDomFilterCards.clear();
    }

    function getCardAuthorMid(card) {
        const cachedMid = card.dataset.bdfFilterAuthorMid || '';
        if (cachedMid) {
            return cachedMid;
        }

        const directMid = extractMidFromElement(card);
        if (directMid) {
            return cacheCardAuthorMid(card, directMid);
        }

        const links = card.querySelectorAll('a[href]');
        for (const link of links) {
            const midFromLink = resolveMidFromUrl(link.getAttribute('href') || '');
            if (midFromLink) {
                return cacheCardAuthorMid(card, midFromLink);
            }
        }

        const dynamicId = getCardDynamicId(card);
        if (dynamicId && state.dynamicAuthorCache.has(dynamicId)) {
            return cacheCardAuthorMid(card, state.dynamicAuthorCache.get(dynamicId) || '');
        }

        const authorName = getCardAuthorName(card);
        if (authorName && state.authorNameCache.has(authorName)) {
            return cacheCardAuthorMid(card, state.authorNameCache.get(authorName) || '');
        }

        const nestedMid = Array.from(card.querySelectorAll('*'))
            .map((element) => extractMidFromElement(element))
            .find(Boolean);
        if (nestedMid) {
            return cacheCardAuthorMid(card, nestedMid);
        }

        const html = card.outerHTML || '';
        let match = html.match(/"(?:mid|vmid|uid|up_mid|author_mid)"\s*:\s*"?([1-9]\d{3,11})"?/);
        if (match) {
            return cacheCardAuthorMid(card, match[1]);
        }
        match = html.match(/\b(?:vmid|mid|uid|up_mid|author_mid)=([1-9]\d{3,11})\b/);
        if (match) {
            return cacheCardAuthorMid(card, match[1]);
        }
        match = html.match(/space\.bilibili\.com\/([1-9]\d{3,11})/);
        if (match) {
            return cacheCardAuthorMid(card, match[1]);
        }

        // 批次顺序绑定只能当“弱提示”，不能像精确解析那样写入永久缓存。
        // 否则一旦 B 站实际渲染顺序和接口 items 顺序发生偏移，就会把错误 UID 长时间留在卡片上。
        const tentativeMid = card.dataset.bdfFeedBatchAuthorMid || '';
        if (tentativeMid) {
            return tentativeMid;
        }

        card.dataset.bdfFilterAuthorMid = '';
        return '';
    }

    function extractMidFromElement(element) {
        if (!element || typeof element.getAttribute !== 'function') {
            return '';
        }

        const directMid = element.getAttribute('data-mid')
            || element.getAttribute('data-user-id')
            || element.getAttribute('data-vmid')
            || element.getAttribute('data-uid')
            || element.getAttribute('mid')
            || element.getAttribute('vmid')
            || element.getAttribute('uid')
            || element.dataset?.mid
            || element.dataset?.userId
            || element.dataset?.vmid
            || element.dataset?.uid;
        if (directMid && isValidMid(String(directMid))) {
            return String(directMid);
        }

        const hrefMid = resolveMidFromUrl(element.getAttribute('href') || '');
        if (hrefMid) {
            return hrefMid;
        }

        const dataUrlMid = resolveMidFromUrl(element.getAttribute('data-url') || '');
        if (dataUrlMid) {
            return dataUrlMid;
        }

        return '';
    }

    function resolveMidFromUrl(urlLike) {
        if (!urlLike) {
            return '';
        }

        let resolvedUrl = urlLike;
        try {
            resolvedUrl = new URL(urlLike, location.origin).href;
        } catch (error) {
            resolvedUrl = urlLike;
        }

        let match = resolvedUrl.match(/space\.bilibili\.com\/([1-9]\d{3,11})/);
        if (match) {
            return match[1];
        }

        try {
            const parsed = new URL(resolvedUrl, location.origin);
            const directMid = parsed.searchParams.get('vmid')
                || parsed.searchParams.get('mid')
                || parsed.searchParams.get('uid')
                || parsed.searchParams.get('up_mid')
                || parsed.searchParams.get('author_mid');
            if (directMid && isValidMid(directMid)) {
                return directMid;
            }

            const windowParams = parsed.searchParams.get('window_params');
            if (windowParams) {
                try {
                    const decoded = JSON.parse(windowParams);
                    const paramsMid = String(decoded?.mid || decoded?.vmid || decoded?.uid || '');
                    if (isValidMid(paramsMid)) {
                        return paramsMid;
                    }
                } catch (error) {
                    // 忽略 window_params 非 JSON 的情况。
                }
            }
        } catch (error) {
            match = resolvedUrl.match(/\b(?:vmid|mid|uid|up_mid|author_mid)=([1-9]\d{3,11})\b/);
            if (match) {
                return match[1];
            }
        }

        return '';
    }

    function getCardDynamicId(card) {
        const cachedId = card.dataset.bdfFilterDynamicId || '';
        if (cachedId) {
            return cachedId;
        }

        const directId = card.getAttribute('data-did')
            || card.getAttribute('data-dynamic-id')
            || card.getAttribute('data-id')
            || card.dataset?.did
            || card.dataset?.dynamicId
            || '';
        if (isValidDynamicId(String(directId))) {
            return cacheCardDynamicId(card, String(directId));
        }

        const html = card.outerHTML || '';
        let match = html.match(/dynamic_(\d{10,})/);
        if (match) {
            return cacheCardDynamicId(card, match[1]);
        }
        match = html.match(/t\.bilibili\.com\/(\d{10,})/);
        if (match) {
            return cacheCardDynamicId(card, match[1]);
        }
        match = html.match(/data-did="(\d{10,})"/);
        if (match) {
            return cacheCardDynamicId(card, match[1]);
        }

        card.dataset.bdfFilterDynamicId = '';
        return '';
    }

    function getCardAuthorName(card) {
        const leadingAuthorName = extractLeadingAuthorNameFromCardText(card);
        if (leadingAuthorName && state.authorNameCache.has(leadingAuthorName)) {
            return leadingAuthorName;
        }

        const authorSelectors = [
            '.bili-dyn-title a[href*="space.bilibili.com"]',
            '.bili-dyn-author a[href*="space.bilibili.com"]',
            '.bili-dyn-title__text a[href*="space.bilibili.com"]',
            '.bili-dyn-title__name a[href*="space.bilibili.com"]',
            '.bili-dyn-title__text',
            '.bili-dyn-title__name',
            '.bili-dyn-author__name',
            '[class*="author"] [class*="name"]',
            'a[title][href*="space.bilibili.com"]',
            'a[href*="space.bilibili.com"]'
        ];
        const candidateNames = [];
        for (const selector of authorSelectors) {
            const element = card.querySelector(selector);
            const name = normalizeAuthorName(element?.getAttribute?.('title') || element?.textContent || '');
            if (looksLikeAuthorNameCandidate(name)) {
                if (state.authorNameCache.has(name)) {
                    return name;
                }
                candidateNames.push(name);
            }
        }

        if (leadingAuthorName) {
            return leadingAuthorName;
        }

        return candidateNames[0] || '';
    }

    function extractLeadingAuthorNameFromCardText(card) {
        const text = (card.textContent || '').replace(/\s+/g, ' ').trim();
        const nameFromText = text.match(/^(.{1,30}?)(?:\s+\d{1,2}(?:分钟前|小时前|天前)|\s+\d{4}-\d{1,2}-\d{1,2}|\s+·)/);
        const normalized = normalizeAuthorName(nameFromText?.[1] || '');
        return looksLikeAuthorNameCandidate(normalized) ? normalized : '';
    }

    function looksLikeAuthorNameCandidate(name) {
        if (!name || name.length > 30) {
            return false;
        }

        // 这里过滤明显不像作者名的长句、动作文案和内容片段，
        // 避免宽泛 class 选择器误把标题、描述或交互按钮文本当成作者名。
        if (/[：:]/.test(name) || /投稿了视频|展开|收起|查看大图|转发|评论|预约|直播|分享图片/.test(name)) {
            return false;
        }

        return !/\d{1,2}(?:分钟前|小时前|天前)|\d{4}-\d{1,2}-\d{1,2}/.test(name);
    }

    function normalizeAuthorName(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function bindPendingAuthorBatchesToCards() {
        if (state.pendingAuthorBatches.length === 0) {
            return;
        }

        while (state.pendingAuthorBatches.length > 0) {
            const batch = state.pendingAuthorBatches[0];
            const cards = getDynamicCards();
            const unboundCards = cards.filter((card) => !card.dataset.bdfFeedBatchBound);
            if (unboundCards.length === 0) {
                break;
            }

            const bindingResult = bindAuthorBatchToCards(unboundCards, batch);

            if (bindingResult.hasConflict) {
                // 一旦已经观察到“卡片自身动态 ID”和“批次中的动态 ID”不一致，
                // 说明当前这批接口数据和当前 DOM 已经明显脱节。此时宁可丢掉这批弱绑定，也不能错绑。
                state.pendingAuthorBatches.shift();
                continue;
            }

            if (bindingResult.remainingBatch.length === 0) {
                state.pendingAuthorBatches.shift();
                continue;
            }

            if (bindingResult.exactBindCount > 0) {
                // 先把已经通过 dynamicId/作者名精确命中的部分从批次头部剥离出去，
                // 剩余部分继续等待后续卡片补齐，避免“同一批里前半段已绑定，后半段永远卡住”。
                state.pendingAuthorBatches[0] = bindingResult.remainingBatch;
            }

            // 剩余条目既没有足够锚点，也无法安全做顺序兜底时，只能等待后续 DOM 补齐。
            break;
        }
    }

    function bindAuthorBatchToCards(unboundCards, batch) {
        const cardByDynamicId = buildUniqueCardIndex(unboundCards, (card) => getCardDynamicId(card));
        const cardByAuthorName = buildUniqueCardIndex(unboundCards, (card) => normalizeAuthorName(getCardAuthorName(card)));
        const boundCards = new Set();
        const remainingBatch = [];
        let exactBindCount = 0;

        batch.forEach((entry) => {
            const matchedCard = resolveBatchEntryExactCard(entry, cardByDynamicId, cardByAuthorName, boundCards);
            if (!matchedCard) {
                remainingBatch.push(entry);
                return;
            }
            bindAuthorEntryToCard(matchedCard, entry);
            boundCards.add(matchedCard);
            exactBindCount += 1;
        });

        const remainingCards = unboundCards.filter((card) => !boundCards.has(card));
        if (remainingBatch.length === 0) {
            return {
                candidateCardCount: 0,
                hasAnchorMatch: exactBindCount > 0,
                hasConflict: false,
                canFallbackBindWithoutAnchor: false,
                exactBindCount,
                fallbackBindCount: 0,
                remainingBatch: []
            };
        }

        if (remainingCards.length < remainingBatch.length) {
            return {
                candidateCardCount: remainingCards.length,
                hasAnchorMatch: exactBindCount > 0,
                hasConflict: false,
                canFallbackBindWithoutAnchor: false,
                exactBindCount,
                fallbackBindCount: 0,
                remainingBatch
            };
        }

        const candidateCards = remainingCards.slice(0, remainingBatch.length);
        const alignment = inspectPendingBatchAlignment(candidateCards, remainingBatch);
        const canFallbackBindWithoutAnchor = (
            !alignment.hasAnchorMatch
            && !alignment.hasConflict
            // 只在“当前剩余未绑定卡片”和“剩余批次数量”完全一致时，才允许无锚点顺序兜底。
            // 这通常意味着页面当前刚好在渲染这一整批新动态，错绑风险相对最低。
            && candidateCards.length === remainingBatch.length
            && candidateCards.length === remainingCards.length
        );

        if (alignment.hasConflict) {
            return {
                candidateCardCount: candidateCards.length,
                hasAnchorMatch: exactBindCount > 0 || alignment.hasAnchorMatch,
                hasConflict: exactBindCount === 0,
                canFallbackBindWithoutAnchor: false,
                exactBindCount,
                fallbackBindCount: 0,
                remainingBatch
            };
        }

        if (!alignment.hasAnchorMatch && !canFallbackBindWithoutAnchor) {
            return {
                candidateCardCount: candidateCards.length,
                hasAnchorMatch: exactBindCount > 0,
                hasConflict: false,
                canFallbackBindWithoutAnchor,
                exactBindCount,
                fallbackBindCount: 0,
                remainingBatch
            };
        }

        remainingBatch.forEach((entry, index) => {
            bindAuthorEntryToCard(candidateCards[index], entry);
        });

        return {
            candidateCardCount: candidateCards.length,
            hasAnchorMatch: true,
            hasConflict: false,
            canFallbackBindWithoutAnchor,
            exactBindCount,
            fallbackBindCount: remainingBatch.length,
            remainingBatch: []
        };
    }

    function buildUniqueCardIndex(cards, getKey) {
        const index = new Map();
        const duplicateKeys = new Set();

        cards.forEach((card) => {
            const key = String(getKey(card) || '');
            if (!key) {
                return;
            }
            if (duplicateKeys.has(key)) {
                return;
            }
            if (index.has(key)) {
                index.delete(key);
                duplicateKeys.add(key);
                return;
            }
            index.set(key, card);
        });

        return index;
    }

    function resolveBatchEntryExactCard(entry, cardByDynamicId, cardByAuthorName, boundCards) {
        const dynamicId = String(entry?.dynamicId || '');
        if (dynamicId) {
            const matchedByDynamicId = cardByDynamicId.get(dynamicId);
            if (matchedByDynamicId && !boundCards.has(matchedByDynamicId)) {
                return matchedByDynamicId;
            }
        }

        const authorName = normalizeAuthorName(entry?.authorName || '');
        if (authorName) {
            const matchedByAuthorName = cardByAuthorName.get(authorName);
            if (matchedByAuthorName && !boundCards.has(matchedByAuthorName)) {
                return matchedByAuthorName;
            }
        }

        return null;
    }

    function bindAuthorEntryToCard(card, entry) {
        if (!card) {
            return;
        }
        card.dataset.bdfFeedBatchBound = '1';
        if (entry?.dynamicId) {
            cacheCardDynamicId(card, entry.dynamicId);
        }
        if (entry?.authorMid) {
            cacheTentativeCardAuthorMid(card, entry.authorMid);
        }
    }

    function inspectPendingBatchAlignment(cards, batch) {
        let hasAnchorMatch = false;
        let hasConflict = false;

        cards.forEach((card, index) => {
            const entry = batch[index];
            const cardDynamicId = getCardDynamicId(card);
            const entryDynamicId = entry?.dynamicId || '';
            const cardAuthorName = getCardAuthorName(card);
            const entryAuthorName = normalizeAuthorName(entry?.authorName || '');
            if (!cardDynamicId || !entryDynamicId) {
                if (!cardAuthorName || !entryAuthorName) {
                    return;
                }
                if (cardAuthorName !== entryAuthorName) {
                    hasConflict = true;
                    return;
                }
                hasAnchorMatch = true;
                return;
            }
            if (cardDynamicId !== entryDynamicId) {
                hasConflict = true;
                return;
            }
            hasAnchorMatch = true;
        });

        return {
            hasAnchorMatch,
            hasConflict
        };
    }

    function detectDynamicTypeFromCard(card) {
        const cachedType = card.dataset.bdfFilterType || '';
        if (cachedType) {
            return cachedType;
        }

        const repostRoot = card.querySelector('.bili-dyn-content__orig.reference');
        const normalRoot = repostRoot || card.querySelector('.bili-dyn-content__orig') || card;
        const majorRoot = normalRoot.querySelector('.bili-dyn-content__orig__major, .bili-dyn-content__major, [class*="major"]');
        const mediaRoot = majorRoot || normalRoot;

        const hasVideo = Boolean(mediaRoot.querySelector('.bili-dyn-card-video, [class*="dyn-card-video"], a[href*="/video/"], a[href*="/bangumi/play/"]'));
        const hasArticle = Boolean(mediaRoot.querySelector('.bili-dyn-card-article, [class*="dyn-card-article"], a[href*="/read/"]'));
        const hasLive = Boolean(mediaRoot.querySelector('[class*="dyn-card-live"], [class*="reserve"], a[href*="live.bilibili.com"]'));
        // 图文动态必须看到更具体的图片容器或图片节点，不能再把宽泛的 opus 容器直接当成有图。
        // 否则纯文字动态也会被误判成 image，导致“纯动态”筛选失效。
        const hasImage = Boolean(mediaRoot.querySelector(
            '.bili-album img, .bili-album picture, [class*="album"] img, [class*="draw"] img, [class*="pics"] img, [class*="img-box"] img, [class*="img-container"] img, [class*="dyn-pics"] img, [class*="opus"] img'
        ));
        // 这里不能再把“存在 major 容器”直接等同于“不是纯文动态”。
        // B 站新版动态里，纯文字内容也可能被包进 major 结构；如果仅凭 major 的存在就排除 text，
        // 最终就会出现“纯文动态全部落到 other”的误判。
        // 因此真正的判定标准应该是：是否存在明确的媒体实体，而不是是否存在 major 外壳。
        const hasKnownMedia = hasVideo || hasArticle || hasLive || hasImage;

        if (repostRoot) {
            return cacheCardType(card, hasVideo ? 'forwardVideo' : 'forward');
        }
        if (hasVideo) {
            return cacheCardType(card, 'video');
        }
        if (hasArticle) {
            return cacheCardType(card, 'article');
        }
        if (hasLive) {
            return cacheCardType(card, 'live');
        }
        if (hasImage) {
            return cacheCardType(card, 'image');
        }
        // 对普通动态来说，只要没有识别到明确媒体实体，就统一视为纯动态。
        // 这是一个有意偏向可用性的收口策略：
        // - 当前 B 站新版动态 DOM 结构不稳定，很多纯文动态无法稳定命中 descRoot；
        // - 继续把这类内容扔进 other，只会导致“纯动态”筛选基本不可用。
        // 现在“纯文动态”已经并入“图文动态”，因此这里不再返回 text，
        // 而是把“非媒体普通动态”也统一并入 image 这个合并后的筛选键。
        if (!hasKnownMedia) {
            return cacheCardType(card, 'image');
        }
        return cacheCardType(card, 'other');
    }

    function getMyUidFromCookie() {
        const match = document.cookie.match(/(?:^|;\s*)DedeUserID=([^;]+)/);
        return match ? match[1] : null;
    }

    function queryFirst(selectors, root = document) {
        if (!Array.isArray(selectors)) {
            return selectors ? root.querySelector(selectors) : null;
        }
        for (const selector of selectors) {
            const matched = root.querySelector(selector);
            if (matched) {
                return matched;
            }
        }
        return null;
    }

    function getDynamicCards() {
        const listContainer = queryFirst(SELECTORS.dynamicListContainers);
        const cards = Array.from((listContainer || document).querySelectorAll(SELECTORS.dynamicCard));
        return cards.filter((card) => isTrackableDynamicCard(card));
    }

    function isTrackableDynamicCard(card) {
        if (!card || !(card instanceof Element) || !card.matches(SELECTORS.dynamicCard)) {
            return false;
        }

        const listContainer = queryFirst(SELECTORS.dynamicListContainers);
        if (listContainer && !listContainer.contains(card)) {
            return false;
        }

        // 只处理动态列表里的顶层卡片。
        // 卡片内部的“相关动态”“图片查看器”等嵌套结构有时也会复用 `.bili-dyn-item`，
        // 如果把这些内部节点一起当作独立动态过滤，就会出现“部分卡片会变化，但分组明显不对”的误判。
        return !card.parentElement?.closest?.(SELECTORS.dynamicCard);
    }

    function markCardForDomFilter(card) {
        if (!isTrackableDynamicCard(card)) {
            return false;
        }
        state.pendingDomFilterCards.add(card);
        return true;
    }

    function markNodeForDomFilter(node) {
        const element = node instanceof Element ? node : node?.parentElement;
        if (!element) {
            return false;
        }

        let marked = false;
        let relatedCard = element.closest?.(SELECTORS.dynamicCard) || null;
        while (relatedCard && !isTrackableDynamicCard(relatedCard)) {
            relatedCard = relatedCard.parentElement?.closest?.(SELECTORS.dynamicCard) || null;
        }
        if (relatedCard) {
            marked = markCardForDomFilter(relatedCard) || marked;
        }

        if (typeof element.querySelectorAll === 'function') {
            element.querySelectorAll(SELECTORS.dynamicCard).forEach((card) => {
                marked = markCardForDomFilter(card) || marked;
            });
        }

        return marked;
    }

    function getCardsToFilter() {
        if (state.domFilterNeedsFullScan) {
            return getDynamicCards();
        }

        return Array.from(state.pendingDomFilterCards).filter((card) => card?.isConnected);
    }

    function isValidMid(value) {
        return REGEX.mid.test(String(value || ''));
    }

    function isValidDynamicId(value) {
        return REGEX.dynamicId.test(String(value || ''));
    }

    function cacheCardAuthorMid(card, authorMid) {
        const normalizedMid = isValidMid(authorMid) ? String(authorMid) : '';
        card.dataset.bdfFilterAuthorMid = normalizedMid;
        delete card.dataset.bdfFeedBatchAuthorMid;
        return normalizedMid;
    }

    function cacheTentativeCardAuthorMid(card, authorMid) {
        const normalizedMid = isValidMid(authorMid) ? String(authorMid) : '';
        if (!normalizedMid) {
            return '';
        }
        card.dataset.bdfFeedBatchAuthorMid = normalizedMid;
        return normalizedMid;
    }

    function cacheCardDynamicId(card, dynamicId) {
        const normalizedId = isValidDynamicId(dynamicId) ? String(dynamicId) : '';
        card.dataset.bdfFilterDynamicId = normalizedId;
        return normalizedId;
    }

    function cacheCardType(card, typeKey) {
        card.dataset.bdfFilterType = typeKey || '';
        return typeKey || '';
    }

    function setDynamicAuthorCache(dynamicId, authorMid) {
        if (!isValidDynamicId(dynamicId) || !isValidMid(authorMid)) {
            return;
        }

        // Map 按插入顺序保存键。这里在覆盖旧值前先删后插，
        // 让最近命中的动态作者映射自然移动到队尾，便于后续做简单的容量裁剪。
        if (state.dynamicAuthorCache.has(dynamicId)) {
            state.dynamicAuthorCache.delete(dynamicId);
        }
        state.dynamicAuthorCache.set(String(dynamicId), String(authorMid));

        while (state.dynamicAuthorCache.size > CONFIG.dynamicAuthorCacheLimit) {
            const oldestKey = state.dynamicAuthorCache.keys().next().value;
            if (!oldestKey) {
                break;
            }
            state.dynamicAuthorCache.delete(oldestKey);
        }
    }

    function setAuthorNameCache(authorName, authorMid) {
        const normalizedName = normalizeAuthorName(authorName);
        const normalizedMid = isValidMid(authorMid) ? String(authorMid) : '';
        if (!normalizedName || !normalizedMid) {
            return;
        }

        const existingMid = state.authorNameCache.get(normalizedName);
        // 同名作者理论上可能撞名；一旦发现一个名称对应多个 UID，就直接放弃这条名称映射，避免错绑。
        if (existingMid && existingMid !== normalizedMid) {
            state.authorNameCache.delete(normalizedName);
            return;
        }

        state.authorNameCache.set(normalizedName, normalizedMid);
    }

    function pushPendingAuthorBatch(batch) {
        state.pendingAuthorBatches.push(batch);
        if (state.pendingAuthorBatches.length > CONFIG.pendingAuthorBatchLimit) {
            state.pendingAuthorBatches.splice(0, state.pendingAuthorBatches.length - CONFIG.pendingAuthorBatchLimit);
        }
    }

    async function requestJson(url) {
        const fetchImpl = state.originalFetch || pageWindow.fetch.bind(pageWindow);
        const response = await fetchImpl(url, { credentials: 'include' });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
    }

    function getRequestUrl(input) {
        if (typeof input === 'string') {
            return input;
        }
        if (input && typeof input === 'object' && typeof input.url === 'string') {
            return input.url;
        }
        if (input && typeof input === 'object' && typeof input.href === 'string') {
            return input.href;
        }
        return String(input || '');
    }

    function ensureToastWrap() {
        let wrap = document.getElementById('bdf-filter-toast-wrap');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'bdf-filter-toast-wrap';
            document.body.appendChild(wrap);
        }
        return wrap;
    }

    function showToast(message, type = 'info') {
        const wrap = ensureToastWrap();
        const toast = document.createElement('div');
        toast.className = `bdf-filter-toast ${type === 'success' ? 'bdf-filter-toast-success' : ''} ${type === 'error' ? 'bdf-filter-toast-error' : ''}`.trim();
        toast.textContent = message;
        wrap.appendChild(toast);
        window.setTimeout(() => toast.remove(), 2600);
    }

    function sleep(ms) {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }
})();
