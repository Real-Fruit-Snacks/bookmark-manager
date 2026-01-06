const { Plugin, ItemView, PluginSettingTab, Setting, Menu, Notice, Modal, requestUrl } = require('obsidian');

const VIEW_TYPE_BOOKMARK_HOMEPAGE = 'bookmark-manager-view';

// Configuration constants for internal behavior (not user-configurable)
const CONFIG = {
    FAVICON_CACHE_MAX_SIZE: 500,           // Maximum number of cached favicons
    LINK_CHECK_TIMEOUT_MS: 10000,          // Timeout for broken link checks
    OPEN_ALL_CONFIRM_THRESHOLD: 10,        // Show confirmation when opening more than this many bookmarks
    FAVICON_PRELOAD_MARGIN_PX: 100,        // IntersectionObserver margin for preloading favicons
    LINK_CHECK_BATCH_SIZE: 5,              // Number of links to check concurrently
};

// Debounce utility for performance optimization
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Sanitize a color value to prevent CSS injection attacks.
 * Accepts hex, rgb, rgba, hsl, hsla colors, and CSS variables.
 * @param {string} color - The color value to validate
 * @returns {string|null} - The validated color or null if invalid
 */
function sanitizeColor(color) {
    if (!color || typeof color !== 'string') return null;

    // Trim and normalize
    const trimmed = color.trim();

    // Allow CSS variables (e.g., var(--my-color))
    if (/^var\(--[\w-]+\)$/.test(trimmed)) {
        return trimmed;
    }

    // Allow hex colors: #RGB, #RRGGBB, #RGBA, #RRGGBBAA
    if (/^#([A-Fa-f0-9]{3}|[A-Fa-f0-9]{4}|[A-Fa-f0-9]{6}|[A-Fa-f0-9]{8})$/.test(trimmed)) {
        return trimmed;
    }

    // Allow rgb/rgba: rgb(0,0,0) or rgba(0,0,0,0.5)
    if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\)$/.test(trimmed)) {
        return trimmed;
    }

    // Allow hsl/hsla: hsl(0,0%,0%) or hsla(0,0%,0%,0.5)
    if (/^hsla?\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*(,\s*[\d.]+\s*)?\)$/.test(trimmed)) {
        return trimmed;
    }

    // Reject anything else (potential CSS injection)
    console.warn(`Bookmark Manager: Invalid color value rejected: "${color}"`);
    return null;
}

// Built-in layout presets for quick switching
const BUILT_IN_PRESETS = {
    'Spacious Grid': {
        grid: { cardMinWidth: 300, cardGap: 24, cardPadding: 20, cardBorderRadius: 12, showFavicons: true, faviconSize: 'large', showUrls: true, showDescriptions: true, showTags: true },
        list: { cardMinWidth: 400, cardGap: 16, cardPadding: 16, cardBorderRadius: 8, showFavicons: true, faviconSize: 'medium', showUrls: true, showDescriptions: true, showTags: true },
        compact: { cardMinWidth: 250, cardGap: 12, cardPadding: 12, cardBorderRadius: 6, showFavicons: true, faviconSize: 'small', showUrls: false, showDescriptions: false, showTags: false }
    },
    'Compact List': {
        grid: { cardMinWidth: 200, cardGap: 8, cardPadding: 10, cardBorderRadius: 4, showFavicons: true, faviconSize: 'small', showUrls: false, showDescriptions: false, showTags: true },
        list: { cardMinWidth: 250, cardGap: 6, cardPadding: 8, cardBorderRadius: 4, showFavicons: true, faviconSize: 'small', showUrls: true, showDescriptions: false, showTags: false },
        compact: { cardMinWidth: 150, cardGap: 4, cardPadding: 6, cardBorderRadius: 2, showFavicons: true, faviconSize: 'small', showUrls: false, showDescriptions: false, showTags: false }
    },
    'Minimal Card': {
        grid: { cardMinWidth: 220, cardGap: 12, cardPadding: 12, cardBorderRadius: 0, showFavicons: false, faviconSize: 'small', showUrls: false, showDescriptions: false, showTags: false },
        list: { cardMinWidth: 280, cardGap: 8, cardPadding: 10, cardBorderRadius: 0, showFavicons: false, faviconSize: 'small', showUrls: false, showDescriptions: false, showTags: false },
        compact: { cardMinWidth: 180, cardGap: 6, cardPadding: 8, cardBorderRadius: 0, showFavicons: false, faviconSize: 'small', showUrls: false, showDescriptions: false, showTags: false }
    },
    'Zen Mode': {
        grid: { cardMinWidth: 280, cardGap: 20, cardPadding: 16, cardBorderRadius: 8, showFavicons: true, faviconSize: 'medium', showUrls: false, showDescriptions: true, showTags: false },
        list: { cardMinWidth: 350, cardGap: 14, cardPadding: 14, cardBorderRadius: 6, showFavicons: true, faviconSize: 'medium', showUrls: false, showDescriptions: true, showTags: false },
        compact: { cardMinWidth: 220, cardGap: 10, cardPadding: 10, cardBorderRadius: 4, showFavicons: true, faviconSize: 'small', showUrls: false, showDescriptions: false, showTags: false }
    }
};

// Centralized default layout values per view mode (single source of truth)
const VIEW_MODE_DEFAULTS = {
    grid: { cardMinWidth: 250, cardGap: 16, cardPadding: 16, cardBorderRadius: 8 },
    list: { cardMinWidth: 300, cardGap: 12, cardPadding: 12, cardBorderRadius: 6 },
    compact: { cardMinWidth: 200, cardGap: 8, cardPadding: 8, cardBorderRadius: 4 }
};

// Lucide SVG icons for modernized header controls
// Source: https://lucide.dev (same icon library used by Obsidian)
const LUCIDE_ICONS = {
    plus: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
    checkSquare: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/></svg>',
    search: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
    x: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    layoutGrid: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>',
    layoutList: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/><path d="M14 4h7"/><path d="M14 9h7"/><path d="M14 15h7"/><path d="M14 20h7"/></svg>',
    rows: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="4" x="3" y="3" rx="1"/><rect width="18" height="4" x="3" y="10" rx="1"/><rect width="18" height="4" x="3" y="17" rx="1"/></svg>',
    tag: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/></svg>',
    barChart: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/></svg>',
    moreHorizontal: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>',
    clipboard: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>',
    chevronsUpDown: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>',
    chevronsDownUp: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/></svg>',
    refreshCw: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>'
};

const DEFAULT_SETTINGS = {
    // Master bookmark storage (keyed by normalized URL)
    // { normalizedUrl: { id, title, url, description, tags[], createdAt, updatedAt } }
    bookmarks: {},

    // Groups contain URL references (not duplicate data)
    // { groupName: { urls: [], icon, color, createdAt } }
    groups: {},
    groupOrder: [], // Display ordering of groups

    // Special sections as URL references
    favoriteUrls: [], // Array of normalized URLs
    recentlyAddedUrls: [], // Array of { url, addedAt }

    // Layout (global fallbacks, but per-view-mode settings take precedence)
    viewMode: 'grid', // 'grid', 'list', 'compact'
    // Per-view-mode settings (layout + display)
    viewModeSettings: {
        grid: {
            // Layout
            cardMinWidth: 250,
            cardGap: 16,
            cardPadding: 16,
            cardBorderRadius: 8,
            // Display
            showFavicons: true,
            faviconSize: 'small',
            showUrls: true,
            showDescriptions: true,
            showTags: true
        },
        list: {
            // Layout
            cardMinWidth: 300,
            cardGap: 12,
            cardPadding: 12,
            cardBorderRadius: 6,
            // Display
            showFavicons: true,
            faviconSize: 'small',
            showUrls: true,
            showDescriptions: false,
            showTags: true
        },
        compact: {
            // Layout
            cardMinWidth: 200,
            cardGap: 8,
            cardPadding: 8,
            cardBorderRadius: 4,
            // Display
            showFavicons: true,
            faviconSize: 'small',
            showUrls: false,
            showDescriptions: false,
            showTags: false
        }
    },
    // Headers
    showMainHeader: true,
    showSectionHeaders: true,
    dashboardTitle: 'Bookmarks',
    dashboardSubtitle: '',
    showHeaderStats: true,
    sectionHeaderSpacing: 16,
    showBookmarkCounts: true,
    // Grouping
    sortOrder: 'default', // 'default', 'alphabetical', 'alphabetical-reverse'
    // Navigation
    showTableOfContents: false,
    collapsibleSections: false,
    persistCollapseState: true,
    // Search
    highlightSearchResults: true,
    stickyControlsBar: true,
    // Effects
    enableAnimations: true,
    enableCardHoverEffects: true,
    enableCollapseAnimations: true,
    // Features
    enableKeyboardShortcuts: true,
    enableTags: true,
    // Special Sections
    showFavorites: true,
    showRecentlyAdded: false,
    recentlyAddedCount: 10,
    showCurrentNoteSection: true, // Show bookmarks found in the currently open note
    showAllCurrentNoteUrls: false, // Show all URLs in current note, not just stored bookmarks
    // Link checking
    ignoredBrokenLinks: [], // Array of URLs marked as good by user
    // Smart Paste
    enableSmartPaste: true,
    smartPasteDefaultGroup: '',
    // Tag Collections
    tagCollections: {},      // { "Collection Name": ["tag1", "tag2"] }
    showTagCloud: true,
    tagFilterMode: 'AND',    // 'AND' or 'OR'
    // Custom Presets
    presets: {},             // { "Preset Name": { grid: {...}, list: {...}, compact: {...} } }
    // Usage Analytics
    enableAnalytics: true,
    mostUsedCount: 10,
    dormantDaysThreshold: 30,
    // Archive System
    enableArchive: true,
    archivedBookmarks: {}, // { normalizedUrl: { ...bookmarkData, archivedAt, originalGroups } }
    archiveRetentionDays: 30, // Auto-delete archived bookmarks after this many days (0 = never)
    showArchivedSection: true, // Show archived bookmarks section in main view
    // UI Features
    enableBulkSelection: true, // Show Select button for bulk operations
    showUncategorized: true, // Show Uncategorized section for bookmarks not in any group
    showOpenAllButtons: true, // Show "Open All" buttons on section headers
    showCollections: true, // Show saved tag collections as sections
    // Advanced Features
    enableDuplicateDetection: true, // Show duplicate detection in Data Management
    enableBrokenLinkDetection: true // Show broken link checker in Data Management
};

/**
 * Escape special regex characters in a string
 * @param {string} string - String to escape
 * @returns {string} - Escaped string safe for use in RegExp
 */
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class FrontpageView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.collapsedSections = new Set();
        this.faviconCache = new Map();
        this.faviconCacheMaxSize = CONFIG.FAVICON_CACHE_MAX_SIZE;
        this.currentSearchQuery = '';
        this.activeTagFilters = new Set(); // Tags currently being filtered
        this.selectionMode = false; // Bulk selection mode
        this.selectedUrls = new Set(); // Selected bookmark URLs for batch operations
        this.currentFile = null; // Track the current note for "Current Note" section
        this._rendering = false; // Render concurrency guard
        this._pendingRender = false; // Track pending render requests
        this._renderAbortController = null; // AbortController for cleanup of render-time event listeners

        // Load persisted collapse state
        if (plugin.settings.persistCollapseState && plugin.collapsedState) {
            this.collapsedSections = new Set(plugin.collapsedState);
        }

        // Initialize IntersectionObserver for lazy favicon loading
        this.faviconObserver = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        const wrapper = entry.target;
                        const url = wrapper.dataset.faviconUrl;
                        const size = parseInt(wrapper.dataset.faviconSize) || 16;
                        if (url) {
                            this.faviconObserver.unobserve(wrapper);
                            this.loadFaviconNow(wrapper, url, size);
                        }
                    }
                }
            },
            { rootMargin: `${CONFIG.FAVICON_PRELOAD_MARGIN_PX}px` } // Start loading slightly before visible
        );

        // Initialize ResizeObserver for container-aware responsiveness
        // This handles sidebar resizing where media queries don't apply
        // Using requestAnimationFrame to prevent "ResizeObserver loop" warnings
        this._resizeRAF = null;
        this.resizeObserver = new ResizeObserver((entries) => {
            // Cancel any pending animation frame to debounce rapid resize events
            if (this._resizeRAF) {
                cancelAnimationFrame(this._resizeRAF);
            }
            this._resizeRAF = requestAnimationFrame(() => {
                for (const entry of entries) {
                    this.applyResponsiveClasses(entry.contentRect.width);
                }
            });
        });
    }

    /**
     * Add an event listener that will be automatically cleaned up on re-render.
     * This prevents memory leaks from accumulating listeners across renders.
     * @param {HTMLElement} element - The element to attach the listener to
     * @param {string} event - The event type (e.g., 'click', 'input')
     * @param {Function} handler - The event handler function
     * @param {Object} [options] - Additional addEventListener options
     */
    _addRenderListener(element, event, handler, options = {}) {
        if (this._renderAbortController) {
            element.addEventListener(event, handler, {
                ...options,
                signal: this._renderAbortController.signal
            });
        } else {
            // Fallback if no AbortController (shouldn't happen in render)
            element.addEventListener(event, handler, options);
        }
    }

    /**
     * Apply responsive CSS classes based on container width
     * @param {number} width - Container width in pixels
     */
    applyResponsiveClasses(width) {
        const container = this.contentEl;

        // Remove all responsive classes first
        container.removeClass(
            'frontpage-narrow',
            'frontpage-medium',
            'frontpage-wide',
            'frontpage-very-narrow'
        );

        // Apply appropriate class based on width
        if (width < 300) {
            container.addClass('frontpage-very-narrow');
        } else if (width < 450) {
            container.addClass('frontpage-narrow');
        } else if (width < 700) {
            container.addClass('frontpage-medium');
        } else {
            container.addClass('frontpage-wide');
        }
    }

    getViewType() {
        return VIEW_TYPE_BOOKMARK_HOMEPAGE;
    }

    getDisplayText() {
        return 'Bookmark Manager';
    }

    getIcon() {
        return 'bookmark';
    }

    async onOpen() {
        // Register keyboard shortcuts once (not on every render to prevent memory leaks)
        this.registerDomEvent(this.contentEl, 'keydown', (e) => {
            if (!this.plugin.settings.enableKeyboardShortcuts) return;

            // Ctrl/Cmd + F to focus search
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                if (this.searchInput) {
                    this.searchInput.focus();
                    this.searchInput.select();
                }
            }
            // Escape to clear search
            if (e.key === 'Escape' && this.searchInput && document.activeElement === this.searchInput) {
                this.searchInput.value = '';
                const clearBtn = this.contentEl.querySelector('.frontpage-search-clear');
                if (clearBtn) clearBtn.style.display = 'none';
                this.filterBookmarks('', this.plugin.settings);
                this.searchInput.blur();
            }
        });

        // Listen for active file changes to update "Current Note" section
        this.registerEvent(
            this.app.workspace.on('file-open', async (file) => {
                // Only re-render if current note section is enabled and a markdown file changed
                if (this.plugin.settings.showCurrentNoteSection && file && file.extension === 'md' && file !== this.currentFile) {
                    this.currentFile = file;
                    await this.render();
                }
            })
        );
        // Also listen for active-leaf-change to handle sidebar focus scenarios
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', async () => {
                if (this.plugin.settings.showCurrentNoteSection) {
                    const file = this.getActiveMarkdownFile();
                    if (file && file !== this.currentFile) {
                        this.currentFile = file;
                        await this.render();
                    }
                }
            })
        );
        // Capture initial active file using our helper that handles sidebar case
        this.currentFile = this.getActiveMarkdownFile();

        // Start observing container for resize events (handles sidebar resizing)
        if (this.resizeObserver) {
            this.resizeObserver.observe(this.contentEl);
        }

        await this.render();
    }

    async render() {
        // Prevent concurrent renders
        if (this._rendering) {
            this._pendingRender = true;
            return;
        }
        this._rendering = true;

        // Clean up event listeners from previous render to prevent memory leaks
        if (this._renderAbortController) {
            this._renderAbortController.abort();
        }
        this._renderAbortController = new AbortController();

        try {
        const container = this.contentEl;
        container.empty();
        container.addClass('frontpage-container');

        const settings = this.plugin.settings;

        // Apply view mode class
        container.removeClass('view-grid', 'view-list', 'view-compact');
        container.addClass(`view-${settings.viewMode}`);

        // Apply animation toggle classes
        container.removeClass('animations-disabled', 'card-effects-disabled', 'collapse-animations-disabled', 'section-headers-hidden');
        if (!settings.enableAnimations) {
            container.addClass('animations-disabled');
        }
        if (!settings.enableCardHoverEffects) {
            container.addClass('card-effects-disabled');
        }
        if (!settings.enableCollapseAnimations) {
            container.addClass('collapse-animations-disabled');
        }
        if (!settings.showSectionHeaders) {
            container.addClass('section-headers-hidden');
        }

        // Get per-view-mode layout settings (using centralized defaults)
        const viewMode = settings.viewMode || 'grid';
        const modeSettings = settings.viewModeSettings?.[viewMode] || {};
        const defaults = VIEW_MODE_DEFAULTS[viewMode] || VIEW_MODE_DEFAULTS.grid;

        // Apply CSS custom properties from per-view-mode settings
        container.style.setProperty('--fp-card-min-width', `${modeSettings.cardMinWidth ?? defaults.cardMinWidth}px`);
        container.style.setProperty('--fp-card-gap', `${modeSettings.cardGap ?? defaults.cardGap}px`);
        container.style.setProperty('--fp-card-radius', `${modeSettings.cardBorderRadius ?? defaults.cardBorderRadius}px`);
        container.style.setProperty('--fp-card-padding', `${modeSettings.cardPadding ?? defaults.cardPadding}px`);
        container.style.setProperty('--fp-header-spacing', `${settings.sectionHeaderSpacing}px`);

        // Get data from settings-based storage (with tag filtering applied)
        const rawFavorites = this.plugin.getFavorites();
        const rawRecentlyAdded = this.plugin.getRecentlyAdded();
        const rawCurrentNote = settings.showCurrentNoteSection ? await this.getCurrentNoteBookmarks() : [];
        const favorites = this.filterBookmarksByTags(rawFavorites);
        const recentlyAdded = this.filterBookmarksByTags(rawRecentlyAdded);
        const currentNoteBookmarks = this.filterBookmarksByTags(rawCurrentNote);

        // Get hierarchical group order for proper parent/child rendering
        const hierarchicalOrder = this.plugin.getHierarchicalGroupOrder();
        let groups = hierarchicalOrder.map(entry => {
            const rawBookmarks = this.plugin.getGroupBookmarks(entry.name);
            return {
                name: entry.name,
                bookmarks: this.filterBookmarksByTags(rawBookmarks),
                icon: settings.groups[entry.name]?.icon || '📁',
                color: settings.groups[entry.name]?.color || null,
                isSubGroup: entry.isSubGroup,
                parentGroup: entry.parent,
                depth: entry.depth
            };
        }).filter(g => {
            // Keep groups with bookmarks OR parent groups with children that have bookmarks
            if (g.bookmarks.length > 0) return true;
            // Keep parent groups that have sub-groups with content
            if (!g.isSubGroup) {
                const children = this.plugin.getSubGroups(g.name);
                return children.some(childName => {
                    const childBookmarks = this.plugin.getGroupBookmarks(childName);
                    return this.filterBookmarksByTags(childBookmarks).length > 0;
                });
            }
            return false;
        });

        // Apply sort order (only for top-level groups, keeping sub-groups with their parents)
        if (settings.sortOrder === 'alphabetical' || settings.sortOrder === 'alphabetical-reverse') {
            // Separate into parent groups with their children
            const parentGroups = groups.filter(g => !g.isSubGroup);
            const sortFn = settings.sortOrder === 'alphabetical'
                ? (a, b) => a.name.localeCompare(b.name)
                : (a, b) => b.name.localeCompare(a.name);
            parentGroups.sort(sortFn);

            // Rebuild with children following their parents
            const sortedGroups = [];
            for (const parent of parentGroups) {
                sortedGroups.push(parent);
                const children = groups.filter(g => g.parentGroup === parent.name);
                children.sort(sortFn);
                sortedGroups.push(...children);
            }
            groups = sortedGroups;
        }
        // 'default' keeps the original hierarchical order

        // Find uncategorized bookmarks (not in any group)
        const allGroupedUrls = new Set();
        for (const group of Object.values(settings.groups)) {
            if (Array.isArray(group.urls)) {
                for (const url of group.urls) {
                    allGroupedUrls.add(url);
                }
            }
        }
        const uncategorized = this.plugin.getAllBookmarks().filter(
            bookmark => !allGroupedUrls.has(this.plugin.normalizeUrl(bookmark.url))
        );

        // Determine if we have any content
        const hasCurrentNote = settings.showCurrentNoteSection && currentNoteBookmarks.length > 0;
        const hasFavorites = settings.showFavorites && favorites.length > 0;
        const hasRecentlyAdded = settings.showRecentlyAdded && recentlyAdded.length > 0;
        const hasGroups = groups.length > 0;
        const hasUncategorized = uncategorized.length > 0;
        const hasContent = hasCurrentNote || hasFavorites || hasRecentlyAdded || hasGroups || hasUncategorized;

        // Create layout wrapper if TOC is enabled
        let contentContainer;
        let tocContainer;

        if (settings.showTableOfContents && hasContent) {
            container.addClass('frontpage-with-toc');
            tocContainer = container.createEl('nav', { cls: 'frontpage-toc' });
            tocContainer.createEl('h3', { cls: 'frontpage-toc-title', text: 'Contents' });
            contentContainer = container.createEl('div', { cls: 'frontpage-content' });
        } else {
            container.removeClass('frontpage-with-toc');
            contentContainer = container;
        }

        if (settings.showMainHeader) {
            const header = contentContainer.createEl('div', { cls: 'frontpage-header' });

            // Title section
            const titleSection = header.createEl('div', { cls: 'frontpage-header-title-section' });
            titleSection.createEl('h1', { text: settings.dashboardTitle });

            if (settings.dashboardSubtitle) {
                titleSection.createEl('p', {
                    cls: 'frontpage-header-subtitle',
                    text: settings.dashboardSubtitle
                });
            }

            // Stats section
            if (settings.showHeaderStats) {
                const statsSection = header.createEl('div', { cls: 'frontpage-header-stats' });

                const totalBookmarks = Object.keys(this.plugin.settings.bookmarks).length;
                const totalGroups = Object.keys(this.plugin.settings.groups).length;
                const totalFavorites = this.plugin.settings.favoriteUrls.length;

                const bookmarkStat = statsSection.createEl('div', { cls: 'frontpage-header-stat' });
                bookmarkStat.createEl('span', { cls: 'frontpage-header-stat-value', text: String(totalBookmarks) });
                bookmarkStat.createEl('span', { cls: 'frontpage-header-stat-label', text: 'Bookmarks' });

                const groupStat = statsSection.createEl('div', { cls: 'frontpage-header-stat' });
                groupStat.createEl('span', { cls: 'frontpage-header-stat-value', text: String(totalGroups) });
                groupStat.createEl('span', { cls: 'frontpage-header-stat-label', text: 'Groups' });

                const favStat = statsSection.createEl('div', { cls: 'frontpage-header-stat' });
                favStat.createEl('span', { cls: 'frontpage-header-stat-value', text: String(totalFavorites) });
                favStat.createEl('span', { cls: 'frontpage-header-stat-label', text: 'Favorites' });
            }
        }

        // Controls bar (search + add + collapse + view mode + refresh)
        const controlsBar = contentContainer.createEl('div', { cls: 'frontpage-controls-bar' });

        // Apply sticky/non-sticky class based on setting
        if (!settings.stickyControlsBar) {
            controlsBar.addClass('not-sticky');
        } else {
            // Add scroll detection for elevated shadow effect
            const sentinel = contentContainer.createEl('div', {
                cls: 'frontpage-scroll-sentinel',
                attr: { 'aria-hidden': 'true' }
            });
            sentinel.style.cssText = 'position: absolute; top: 0; height: 1px; width: 1px; pointer-events: none;';

            // Disconnect previous scroll observer if exists
            if (this.scrollObserver) {
                this.scrollObserver.disconnect();
            }

            this.scrollObserver = new IntersectionObserver(
                (entries) => {
                    entries.forEach(entry => {
                        controlsBar.classList.toggle('is-scrolled', !entry.isIntersecting);
                    });
                },
                { threshold: 0, rootMargin: '-1px 0px 0px 0px' }
            );
            this.scrollObserver.observe(sentinel);
        }

        // === LEFT ZONE: Primary Actions ===
        const primaryZone = controlsBar.createEl('div', { cls: 'fp-zone-primary' });

        // Add button (primary style - most prominent)
        const addBookmarkBtn = primaryZone.createEl('button', {
            cls: 'fp-btn fp-btn-primary',
            attr: { title: 'Add new bookmark', 'aria-label': 'Add new bookmark' }
        });
        addBookmarkBtn.innerHTML = LUCIDE_ICONS.plus;
        addBookmarkBtn.createEl('span', { cls: 'fp-btn-text', text: 'Add' });
        this._addRenderListener(addBookmarkBtn, 'click', () => {
            new QuickAddBookmarkModal(this.app, this.plugin).open();
        });

        // Select button for bulk operations (ghost style) - collapses at narrow widths
        if (settings.enableBulkSelection) {
            const selectBtn = primaryZone.createEl('button', {
                cls: `fp-btn fp-btn-ghost fp-collapse-narrow ${this.selectionMode ? 'is-active' : ''}`,
                attr: {
                    title: this.selectionMode ? 'Cancel selection' : 'Select multiple bookmarks',
                    'aria-pressed': this.selectionMode ? 'true' : 'false',
                    'aria-label': 'Bulk selection mode'
                }
            });
            selectBtn.innerHTML = LUCIDE_ICONS.checkSquare;
            this._addRenderListener(selectBtn, 'click', () => {
                this.toggleSelectionMode();
            });
        }

        // === CENTER ZONE: Search ===
        const searchZone = controlsBar.createEl('div', { cls: 'fp-zone-search', attr: { role: 'search' } });

        // Search icon (decorative)
        const searchIcon = searchZone.createEl('span', { cls: 'fp-search-icon', attr: { 'aria-hidden': 'true' } });
        searchIcon.innerHTML = LUCIDE_ICONS.search;

        // Search input
        const searchInput = searchZone.createEl('input', {
            cls: 'fp-search-input',
            attr: { type: 'search', placeholder: 'Search bookmarks...', 'aria-label': 'Search bookmarks' }
        });

        // Clear button
        const clearSearchBtn = searchZone.createEl('button', {
            cls: 'fp-search-clear',
            attr: { type: 'button', 'aria-label': 'Clear search' }
        });
        clearSearchBtn.innerHTML = LUCIDE_ICONS.x;

        this.searchInput = searchInput;
        this._addRenderListener(searchInput, 'input', (e) => {
            const query = e.target.value;
            clearSearchBtn.classList.toggle('is-visible', !!query);
            this.filterBookmarks(query, settings);
        });

        this._addRenderListener(clearSearchBtn, 'click', () => {
            searchInput.value = '';
            clearSearchBtn.classList.remove('is-visible');
            this.filterBookmarks('', settings);
            searchInput.focus();
        });

        // === RIGHT ZONE: Secondary Actions ===
        const secondaryZone = controlsBar.createEl('div', { cls: 'fp-zone-secondary' });

        // View mode segmented control - collapses at very narrow widths
        const viewToggle = secondaryZone.createEl('div', {
            cls: 'fp-view-toggle fp-collapse-very-narrow',
            attr: { role: 'group', 'aria-label': 'View mode' }
        });

        const viewModes = [
            { mode: 'grid', icon: LUCIDE_ICONS.layoutGrid, label: 'Grid view' },
            { mode: 'list', icon: LUCIDE_ICONS.layoutList, label: 'List view' },
            { mode: 'compact', icon: LUCIDE_ICONS.rows, label: 'Compact view' }
        ];

        viewModes.forEach(({ mode, icon, label }) => {
            const btn = viewToggle.createEl('button', {
                cls: mode === settings.viewMode ? 'is-active' : '',
                attr: {
                    'data-view': mode,
                    'aria-pressed': mode === settings.viewMode ? 'true' : 'false',
                    'aria-label': label,
                    title: label
                }
            });
            btn.innerHTML = icon;
            this._addRenderListener(btn, 'click', async () => {
                // Update active states
                viewToggle.querySelectorAll('button').forEach(b => {
                    b.classList.remove('is-active');
                    b.setAttribute('aria-pressed', 'false');
                });
                btn.classList.add('is-active');
                btn.setAttribute('aria-pressed', 'true');

                this.plugin.settings.viewMode = mode;
                await this.plugin.saveSettings();
            });
        });

        // Divider - collapses at narrow widths (already hidden by CSS, but mark it)
        secondaryZone.createEl('div', { cls: 'fp-divider fp-collapse-narrow' });

        // Filter button (ghost style) - collapses at narrow widths
        const allTags = this.plugin.getAllTags();
        const hasTagFilter = settings.enableTags && allTags.size > 0;
        if (hasTagFilter) {
            const filterBtn = secondaryZone.createEl('button', {
                cls: `fp-btn fp-btn-ghost fp-collapse-narrow ${this.activeTagFilters.size > 0 ? 'is-active' : ''}`,
                attr: {
                    title: 'Filter by tags',
                    'aria-label': 'Filter by tags'
                }
            });
            filterBtn.innerHTML = LUCIDE_ICONS.tag;
            if (this.activeTagFilters.size > 0) {
                filterBtn.createEl('span', {
                    cls: 'fp-filter-badge',
                    text: String(this.activeTagFilters.size)
                });
            }
            this._addRenderListener(filterBtn, 'click', () => {
                new TagFilterModal(this.app, this.plugin, this).open();
            });
        }

        // Insights button (ghost style) - collapses at narrow widths
        if (settings.enableAnalytics) {
            const insightsBtn = secondaryZone.createEl('button', {
                cls: 'fp-btn fp-btn-ghost fp-collapse-narrow',
                attr: { title: 'View bookmark insights', 'aria-label': 'Bookmark insights' }
            });
            insightsBtn.innerHTML = LUCIDE_ICONS.barChart;
            this._addRenderListener(insightsBtn, 'click', () => {
                new InsightsModal(this.app, this.plugin).open();
            });
        }

        // Overflow menu button (contains collapsed actions + Paste, Collapse, Expand, Refresh)
        const overflowBtn = secondaryZone.createEl('button', {
            cls: 'fp-btn fp-btn-ghost',
            attr: { title: 'More actions', 'aria-label': 'More actions', 'aria-haspopup': 'menu' }
        });
        overflowBtn.innerHTML = LUCIDE_ICONS.moreHorizontal;

        this._addRenderListener(overflowBtn, 'click', (e) => {
            const menu = new Menu();
            const isNarrow = container.hasClass('frontpage-narrow') || container.hasClass('frontpage-very-narrow');
            const isVeryNarrow = container.hasClass('frontpage-very-narrow');

            // === Collapsed items (shown only at narrow widths) ===

            // Select mode (collapsed at narrow)
            if (isNarrow && settings.enableBulkSelection) {
                menu.addItem(item => {
                    item.setTitle(this.selectionMode ? 'Cancel Selection' : 'Select Multiple')
                        .setIcon('check-square')
                        .onClick(() => this.toggleSelectionMode());
                });
            }

            // Filter by tags (collapsed at narrow)
            if (isNarrow && hasTagFilter) {
                menu.addItem(item => {
                    const title = this.activeTagFilters.size > 0
                        ? `Filter by Tags (${this.activeTagFilters.size})`
                        : 'Filter by Tags';
                    item.setTitle(title)
                        .setIcon('tag')
                        .onClick(() => new TagFilterModal(this.app, this.plugin, this).open());
                });
            }

            // Insights (collapsed at narrow)
            if (isNarrow && settings.enableAnalytics) {
                menu.addItem(item => {
                    item.setTitle('Insights')
                        .setIcon('bar-chart-2')
                        .onClick(() => new InsightsModal(this.app, this.plugin).open());
                });
            }

            // View mode submenu (collapsed at very narrow)
            if (isVeryNarrow) {
                menu.addItem(item => {
                    item.setTitle('View Mode')
                        .setIcon('layout-grid');
                    const submenu = item.setSubmenu();
                    viewModes.forEach(({ mode, label }) => {
                        submenu.addItem(sub => {
                            sub.setTitle(label)
                                .setChecked(settings.viewMode === mode)
                                .onClick(async () => {
                                    this.plugin.settings.viewMode = mode;
                                    await this.plugin.saveSettings();
                                });
                        });
                    });
                });
            }

            // Add separator if we added collapsed items
            if (isNarrow) {
                menu.addSeparator();
            }

            // === Always-present items ===

            // Smart Paste
            if (settings.enableSmartPaste) {
                menu.addItem(item => {
                    item.setTitle('Paste URL')
                        .setIcon('clipboard-paste')
                        .onClick(() => this.smartPasteBookmark(overflowBtn));
                });
            }

            // Collapse/Expand
            if (settings.collapsibleSections) {
                menu.addItem(item => {
                    item.setTitle('Collapse All')
                        .setIcon('chevrons-down-up')
                        .onClick(() => this.collapseAll());
                });
                menu.addItem(item => {
                    item.setTitle('Expand All')
                        .setIcon('chevrons-up-down')
                        .onClick(() => this.expandAll());
                });
            }

            menu.addSeparator();

            // Refresh
            menu.addItem(item => {
                item.setTitle('Refresh')
                    .setIcon('refresh-cw')
                    .onClick(() => this.render());
            });

            menu.showAtMouseEvent(e);
        });

        // No results message (hidden by default)
        const noResultsEl = contentContainer.createEl('div', {
            cls: 'frontpage-no-results',
            attr: { style: 'display: none;' }
        });
        noResultsEl.createEl('div', { cls: 'frontpage-no-results-icon', text: '🔍' });
        noResultsEl.createEl('p', { text: 'No bookmarks found matching your search.' });
        const clearSearchInResultsBtn = noResultsEl.createEl('button', {
            cls: 'fp-btn fp-btn-ghost',
            text: 'Clear Search'
        });
        this._addRenderListener(clearSearchInResultsBtn, 'click', () => {
            searchInput.value = '';
            clearSearchBtn.classList.remove('is-visible');
            this.filterBookmarks('', settings);
        });
        this.noResultsEl = noResultsEl;

        // Check if we have any content to display
        if (!hasContent) {
            const emptyState = contentContainer.createEl('div', { cls: 'frontpage-empty' });
            emptyState.createEl('div', { cls: 'frontpage-empty-icon', text: '📚' });
            emptyState.createEl('div', { cls: 'frontpage-empty-title', text: 'No bookmarks yet' });
            emptyState.createEl('div', {
                cls: 'frontpage-empty-subtitle',
                text: 'Click below to add your first bookmark.'
            });
            const addBtn = emptyState.createEl('button', { cls: 'frontpage-empty-action' });
            addBtn.createEl('span', { text: '＋' });
            addBtn.createEl('span', { text: 'Add Your First Bookmark' });
            this._addRenderListener(addBtn, 'click', () => {
                new QuickAddBookmarkModal(this.app, this.plugin).open();
            });
            return;
        }

        // Bookmarks container for search filtering
        const bookmarksContainer = contentContainer.createEl('div', { cls: 'frontpage-bookmarks-container' });
        this.bookmarksContainer = bookmarksContainer;

        // Build TOC
        const tocList = tocContainer ? tocContainer.createEl('ul', { cls: 'frontpage-toc-list' }) : null;

        // Render Current Note section at the very top
        if (hasCurrentNote) {
            const currentNoteId = 'frontpage-current-note';
            const isCurrentNoteCollapsed = this.collapsedSections.has(currentNoteId);

            const currentNoteSection = bookmarksContainer.createEl('div', {
                cls: `frontpage-folder frontpage-special-group frontpage-current-note-group ${isCurrentNoteCollapsed ? 'is-collapsed' : ''}`,
                attr: { id: currentNoteId }
            });

            // Add to TOC
            if (tocList) {
                const tocItem = tocList.createEl('li', { cls: 'frontpage-toc-item' });
                const tocLink = tocItem.createEl('a', {
                    cls: 'frontpage-toc-link frontpage-toc-folder frontpage-toc-current-note',
                    href: `#${currentNoteId}`
                });
                tocLink.createEl('span', { text: '📄 Current Note' });
                if (settings.showBookmarkCounts) {
                    tocLink.createEl('span', { cls: 'frontpage-toc-count', text: `${currentNoteBookmarks.length}` });
                }
                this._addRenderListener(tocLink, 'click', (e) => {
                    e.preventDefault();
                    currentNoteSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
            }

            // Current Note header
            const currentNoteHeader = currentNoteSection.createEl('div', { cls: 'frontpage-folder-header frontpage-current-note-header' });

            if (settings.collapsibleSections) {
                const collapseIcon = currentNoteHeader.createEl('span', {
                    cls: `frontpage-collapse-icon ${isCurrentNoteCollapsed ? 'is-collapsed' : ''}`,
                    text: '▼'
                });
                currentNoteHeader.addClass('is-collapsible');
                this._addRenderListener(currentNoteHeader, 'click', () => {
                    const nowCollapsed = !this.collapsedSections.has(currentNoteId);
                    if (nowCollapsed) {
                        this.collapsedSections.add(currentNoteId);
                        currentNoteSection.addClass('is-collapsed');
                        collapseIcon.addClass('is-collapsed');
                    } else {
                        this.collapsedSections.delete(currentNoteId);
                        currentNoteSection.removeClass('is-collapsed');
                        collapseIcon.removeClass('is-collapsed');
                    }
                    this.saveCollapseState();
                });
            }

            const titleWrapper = currentNoteHeader.createEl('div', { cls: 'frontpage-title-wrapper' });
            titleWrapper.createEl('h2', {
                cls: 'frontpage-folder-title frontpage-current-note-title',
                text: '📄 Current Note'
            });
            if (settings.showBookmarkCounts) {
                titleWrapper.createEl('span', {
                    cls: 'frontpage-bookmark-count',
                    text: `${currentNoteBookmarks.length}`
                });
            }

            // Open all button
            if (settings.showOpenAllButtons) {
                const openAllBtn = currentNoteHeader.createEl('button', {
                    cls: 'frontpage-open-all-btn',
                    attr: { title: 'Open all bookmarks in new tabs' }
                });
                openAllBtn.textContent = '↗';
                openAllBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.openAllBookmarks(currentNoteBookmarks);
                });
            }

            const currentNoteContent = currentNoteSection.createEl('div', { cls: 'frontpage-folder-content' });
            const currentNoteGrid = currentNoteContent.createEl('div', { cls: 'frontpage-grid' });
            this.renderBookmarks(currentNoteGrid, currentNoteBookmarks, settings, { isSpecialGroup: true, groupName: 'Current Note' });
        }

        // Render Favorites section at the top
        if (hasFavorites) {
            const favoritesId = 'frontpage-favorites';
            const isFavoritesCollapsed = this.collapsedSections.has(favoritesId);

            const favoritesSection = bookmarksContainer.createEl('div', {
                cls: `frontpage-folder frontpage-special-group frontpage-favorites-group ${isFavoritesCollapsed ? 'is-collapsed' : ''}`,
                attr: { id: favoritesId }
            });

            // Add to TOC
            if (tocList) {
                const tocItem = tocList.createEl('li', { cls: 'frontpage-toc-item' });
                const tocLink = tocItem.createEl('a', {
                    cls: 'frontpage-toc-link frontpage-toc-folder frontpage-toc-favorites',
                    href: `#${favoritesId}`
                });
                tocLink.createEl('span', { text: '⭐ Favorites' });
                if (settings.showBookmarkCounts) {
                    tocLink.createEl('span', { cls: 'frontpage-toc-count', text: `${favorites.length}` });
                }
                tocLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    favoritesSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
            }

            // Favorites header
            const favoritesHeader = favoritesSection.createEl('div', { cls: 'frontpage-folder-header frontpage-favorites-header' });

            // Context menu on favorites header
            favoritesHeader.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.showFavoritesContextMenu(e);
            });

            if (settings.collapsibleSections) {
                const collapseIcon = favoritesHeader.createEl('span', {
                    cls: `frontpage-collapse-icon ${isFavoritesCollapsed ? 'is-collapsed' : ''}`,
                    text: '▼'
                });
                favoritesHeader.addClass('is-collapsible');
                favoritesHeader.addEventListener('click', () => {
                    const nowCollapsed = !this.collapsedSections.has(favoritesId);
                    if (nowCollapsed) {
                        this.collapsedSections.add(favoritesId);
                        favoritesSection.addClass('is-collapsed');
                        collapseIcon.addClass('is-collapsed');
                    } else {
                        this.collapsedSections.delete(favoritesId);
                        favoritesSection.removeClass('is-collapsed');
                        collapseIcon.removeClass('is-collapsed');
                    }
                    this.saveCollapseState();
                });
            }

            const titleWrapper = favoritesHeader.createEl('div', { cls: 'frontpage-title-wrapper' });
            titleWrapper.createEl('h2', {
                cls: 'frontpage-folder-title frontpage-favorites-title',
                text: '⭐ Favorites'
            });
            if (settings.showBookmarkCounts) {
                titleWrapper.createEl('span', {
                    cls: 'frontpage-bookmark-count',
                    text: `${favorites.length}`
                });
            }

            // Open all button
            if (settings.showOpenAllButtons) {
                const openAllBtn = favoritesHeader.createEl('button', {
                    cls: 'frontpage-open-all-btn',
                    attr: { title: 'Open all bookmarks in new tabs' }
                });
                openAllBtn.textContent = '↗';
                openAllBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.openAllBookmarks(favorites);
                });
            }

            const favoritesContent = favoritesSection.createEl('div', { cls: 'frontpage-folder-content' });
            const favoritesGrid = favoritesContent.createEl('div', { cls: 'frontpage-grid' });
            this.renderBookmarks(favoritesGrid, favorites, settings, { isSpecialGroup: true, groupName: 'Favorites' });
        }

        // Render Recently Added section
        if (hasRecentlyAdded) {
            const recentId = 'frontpage-recently-added';
            const isRecentCollapsed = this.collapsedSections.has(recentId);

            const recentSection = bookmarksContainer.createEl('div', {
                cls: `frontpage-folder frontpage-special-group frontpage-recent-group ${isRecentCollapsed ? 'is-collapsed' : ''}`,
                attr: { id: recentId }
            });

            // Add to TOC
            if (tocList) {
                const tocItem = tocList.createEl('li', { cls: 'frontpage-toc-item' });
                const tocLink = tocItem.createEl('a', {
                    cls: 'frontpage-toc-link frontpage-toc-folder frontpage-toc-recent',
                    href: `#${recentId}`
                });
                tocLink.createEl('span', { text: '🕐 Recently Added' });
                if (settings.showBookmarkCounts) {
                    tocLink.createEl('span', { cls: 'frontpage-toc-count', text: `${recentlyAdded.length}` });
                }
                tocLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    recentSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
            }

            // Recent header
            const recentHeader = recentSection.createEl('div', { cls: 'frontpage-folder-header frontpage-recent-header' });

            // Context menu on recently added header
            recentHeader.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.showRecentlyAddedContextMenu(e);
            });

            if (settings.collapsibleSections) {
                const collapseIcon = recentHeader.createEl('span', {
                    cls: `frontpage-collapse-icon ${isRecentCollapsed ? 'is-collapsed' : ''}`,
                    text: '▼'
                });
                recentHeader.addClass('is-collapsible');
                recentHeader.addEventListener('click', () => {
                    const nowCollapsed = !this.collapsedSections.has(recentId);
                    if (nowCollapsed) {
                        this.collapsedSections.add(recentId);
                        recentSection.addClass('is-collapsed');
                        collapseIcon.addClass('is-collapsed');
                    } else {
                        this.collapsedSections.delete(recentId);
                        recentSection.removeClass('is-collapsed');
                        collapseIcon.removeClass('is-collapsed');
                    }
                    this.saveCollapseState();
                });
            }

            const titleWrapper = recentHeader.createEl('div', { cls: 'frontpage-title-wrapper' });
            titleWrapper.createEl('h2', {
                cls: 'frontpage-folder-title frontpage-recent-title',
                text: '🕐 Recently Added'
            });
            if (settings.showBookmarkCounts) {
                titleWrapper.createEl('span', {
                    cls: 'frontpage-bookmark-count',
                    text: `${recentlyAdded.length}`
                });
            }

            // Open all button
            if (settings.showOpenAllButtons) {
                const openAllBtn = recentHeader.createEl('button', {
                    cls: 'frontpage-open-all-btn',
                    attr: { title: 'Open all bookmarks in new tabs' }
                });
                openAllBtn.textContent = '↗';
                openAllBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.openAllBookmarks(recentlyAdded);
                });
            }

            const recentContent = recentSection.createEl('div', { cls: 'frontpage-folder-content' });
            const recentGrid = recentContent.createEl('div', { cls: 'frontpage-grid' });
            this.renderBookmarks(recentGrid, recentlyAdded, settings, { isSpecialGroup: true, groupName: 'Recently Added' });
        }

        // Render Tag Cloud (if tags enabled, showTagCloud enabled, and tags exist)
        if (settings.enableTags && settings.showTagCloud) {
            this.renderTagCloud(bookmarksContainer, settings);
        }

        // Render Collections (saved tag filters) - requires tags enabled
        if (settings.enableTags && settings.showCollections && settings.tagCollections && Object.keys(settings.tagCollections).length > 0 && this.activeTagFilters.size === 0) {
            for (const [collectionName, collectionTags] of Object.entries(settings.tagCollections)) {
                const collectionBookmarks = this.plugin.getBookmarksByTags(collectionTags, settings.tagFilterMode);
                if (collectionBookmarks.length === 0) continue;

                const collectionSection = bookmarksContainer.createEl('div', {
                    cls: 'frontpage-folder frontpage-special-group frontpage-collection-group'
                });

                const collectionHeader = collectionSection.createEl('div', { cls: 'frontpage-folder-header' });
                const titleWrapper = collectionHeader.createEl('div', { cls: 'frontpage-title-wrapper' });
                titleWrapper.createEl('h2', {
                    cls: 'frontpage-folder-title frontpage-collection-title',
                    text: `📚 ${collectionName}`
                });
                if (settings.showBookmarkCounts) {
                    titleWrapper.createEl('span', {
                        cls: 'frontpage-bookmark-count',
                        text: `${collectionBookmarks.length}`
                    });
                }

                // Collection tags preview
                const tagPreview = collectionHeader.createEl('div', { cls: 'frontpage-collection-tag-preview' });
                for (const tag of collectionTags.slice(0, 3)) {
                    tagPreview.createEl('span', { cls: 'frontpage-mini-tag', text: tag });
                }
                if (collectionTags.length > 3) {
                    tagPreview.createEl('span', { cls: 'frontpage-mini-tag-more', text: `+${collectionTags.length - 3}` });
                }

                // Context menu for collection
                collectionHeader.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.showCollectionContextMenu(e, collectionName, collectionTags);
                });

                const collectionContent = collectionSection.createEl('div', { cls: 'frontpage-folder-content' });
                const collectionGrid = collectionContent.createEl('div', { cls: 'frontpage-grid' });
                this.renderBookmarks(collectionGrid, collectionBookmarks, settings, { isSpecialGroup: true, groupName: collectionName });
            }
        }

        // Render Groups
        for (const group of groups) {
            const groupId = `frontpage-group-${group.name.replace(/\s+/g, '-').toLowerCase()}`;
            const isGroupCollapsed = this.collapsedSections.has(groupId);

            // Add sub-group class if this is a child group
            const subGroupClass = group.isSubGroup ? 'frontpage-subgroup' : 'frontpage-parent-group';
            const groupSection = bookmarksContainer.createEl('div', {
                cls: `frontpage-folder frontpage-special-group frontpage-custom-group ${subGroupClass} ${isGroupCollapsed ? 'is-collapsed' : ''}`,
                attr: {
                    id: groupId,
                    'data-parent-group': group.parentGroup || '',
                    'data-depth': String(group.depth || 0)
                }
            });

            // Apply custom color if set (with validation to prevent CSS injection)
            const safeGroupColor = sanitizeColor(group.color);
            if (safeGroupColor) {
                groupSection.style.setProperty('--group-color', safeGroupColor);
            }

            // Add to TOC
            if (tocList) {
                const tocItemClass = group.isSubGroup ? 'frontpage-toc-item frontpage-toc-subitem' : 'frontpage-toc-item';
                const tocItem = tocList.createEl('li', { cls: tocItemClass });
                const tocLinkClass = group.isSubGroup
                    ? 'frontpage-toc-link frontpage-toc-folder frontpage-toc-subgroup'
                    : 'frontpage-toc-link frontpage-toc-folder';
                const tocLink = tocItem.createEl('a', {
                    cls: tocLinkClass,
                    href: `#${groupId}`
                });
                const displayName = group.isSubGroup ? `└ ${group.icon} ${group.name}` : `${group.icon} ${group.name}`;
                tocLink.createEl('span', { text: displayName });
                if (settings.showBookmarkCounts) {
                    tocLink.createEl('span', { cls: 'frontpage-toc-count', text: `${group.bookmarks.length}` });
                }
                tocLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    groupSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
            }

            // Group header
            const groupHeader = groupSection.createEl('div', { cls: 'frontpage-folder-header' });

            // Context menu on custom group header
            groupHeader.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.showGroupContextMenu(e, group.name, group.bookmarks);
            });

            if (settings.collapsibleSections) {
                const collapseIcon = groupHeader.createEl('span', {
                    cls: `frontpage-collapse-icon ${isGroupCollapsed ? 'is-collapsed' : ''}`,
                    text: '▼'
                });
                groupHeader.addClass('is-collapsible');
                groupHeader.addEventListener('click', () => {
                    const nowCollapsed = !this.collapsedSections.has(groupId);
                    if (nowCollapsed) {
                        this.collapsedSections.add(groupId);
                        groupSection.addClass('is-collapsed');
                        collapseIcon.addClass('is-collapsed');
                    } else {
                        this.collapsedSections.delete(groupId);
                        groupSection.removeClass('is-collapsed');
                        collapseIcon.removeClass('is-collapsed');
                    }
                    this.saveCollapseState();
                });
            }

            const titleWrapper = groupHeader.createEl('div', { cls: 'frontpage-title-wrapper' });
            // Use h3 for sub-groups, h2 for top-level groups
            const titleTag = group.isSubGroup ? 'h3' : 'h2';
            titleWrapper.createEl(titleTag, {
                cls: 'frontpage-folder-title',
                text: `${group.icon} ${group.name}`
            });
            if (settings.showBookmarkCounts) {
                titleWrapper.createEl('span', {
                    cls: 'frontpage-bookmark-count',
                    text: `${group.bookmarks.length}`
                });
            }

            // Open all button
            if (settings.showOpenAllButtons) {
                const openAllBtn = groupHeader.createEl('button', {
                    cls: 'frontpage-open-all-btn',
                    attr: { title: 'Open all bookmarks in new tabs' }
                });
                openAllBtn.textContent = '↗';
                openAllBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.openAllBookmarks(group.bookmarks);
                });
            }

            const groupContent = groupSection.createEl('div', { cls: 'frontpage-folder-content' });
            const groupGrid = groupContent.createEl('div', { cls: 'frontpage-grid' });
            this.renderBookmarks(groupGrid, group.bookmarks, settings, { isSpecialGroup: true, groupName: group.name });
        }

        // Render Uncategorized section (bookmarks not in any group)
        if (hasUncategorized && settings.showUncategorized) {
            const uncategorizedId = 'frontpage-uncategorized';
            const isUncategorizedCollapsed = this.collapsedSections.has(uncategorizedId);

            const uncategorizedSection = bookmarksContainer.createEl('div', {
                cls: `frontpage-folder frontpage-special-group frontpage-uncategorized-group ${isUncategorizedCollapsed ? 'is-collapsed' : ''}`,
                attr: { id: uncategorizedId }
            });

            // Add to TOC
            if (tocList) {
                const tocItem = tocList.createEl('li', { cls: 'frontpage-toc-item' });
                const tocLink = tocItem.createEl('a', {
                    cls: 'frontpage-toc-link frontpage-toc-folder frontpage-toc-uncategorized',
                    href: `#${uncategorizedId}`
                });
                tocLink.createEl('span', { text: '📋 Uncategorized' });
                if (settings.showBookmarkCounts) {
                    tocLink.createEl('span', { cls: 'frontpage-toc-count', text: `${uncategorized.length}` });
                }
                tocLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    uncategorizedSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
            }

            // Uncategorized header
            const uncategorizedHeader = uncategorizedSection.createEl('div', { cls: 'frontpage-folder-header frontpage-uncategorized-header' });

            // Context menu on uncategorized header
            uncategorizedHeader.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.showUncategorizedContextMenu(e, uncategorized);
            });

            if (settings.collapsibleSections) {
                const collapseIcon = uncategorizedHeader.createEl('span', {
                    cls: `frontpage-collapse-icon ${isUncategorizedCollapsed ? 'is-collapsed' : ''}`,
                    text: '▼'
                });
                uncategorizedHeader.addClass('is-collapsible');
                uncategorizedHeader.addEventListener('click', () => {
                    const nowCollapsed = !this.collapsedSections.has(uncategorizedId);
                    if (nowCollapsed) {
                        this.collapsedSections.add(uncategorizedId);
                        uncategorizedSection.addClass('is-collapsed');
                        collapseIcon.addClass('is-collapsed');
                    } else {
                        this.collapsedSections.delete(uncategorizedId);
                        uncategorizedSection.removeClass('is-collapsed');
                        collapseIcon.removeClass('is-collapsed');
                    }
                    this.saveCollapseState();
                });
            }

            const titleWrapper = uncategorizedHeader.createEl('div', { cls: 'frontpage-title-wrapper' });
            titleWrapper.createEl('h2', {
                cls: 'frontpage-folder-title frontpage-uncategorized-title',
                text: '📋 Uncategorized'
            });
            if (settings.showBookmarkCounts) {
                titleWrapper.createEl('span', {
                    cls: 'frontpage-bookmark-count',
                    text: `${uncategorized.length}`
                });
            }

            // Open all button
            if (settings.showOpenAllButtons) {
                const openAllBtn = uncategorizedHeader.createEl('button', {
                    cls: 'frontpage-open-all-btn',
                    attr: { title: 'Open all bookmarks in new tabs' }
                });
                openAllBtn.textContent = '↗';
                openAllBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.openAllBookmarks(uncategorized);
                });
            }

            const uncategorizedContent = uncategorizedSection.createEl('div', { cls: 'frontpage-folder-content' });
            const uncategorizedGrid = uncategorizedContent.createEl('div', { cls: 'frontpage-grid' });
            this.renderBookmarks(uncategorizedGrid, uncategorized, settings, { isSpecialGroup: true, groupName: 'Uncategorized' });
        }

        // Render Archive section (if enabled and has archived items)
        const archivedBookmarks = this.plugin.getArchivedBookmarks();
        if (settings.showArchivedSection && archivedBookmarks.length > 0) {
            const archiveId = 'frontpage-archive';
            const isArchiveCollapsed = this.collapsedSections.has(archiveId);

            const archiveSection = bookmarksContainer.createEl('div', {
                cls: `frontpage-folder frontpage-special-group frontpage-archive-group ${isArchiveCollapsed ? 'is-collapsed' : ''}`,
                attr: { id: archiveId }
            });

            const archiveHeader = archiveSection.createEl('div', { cls: 'frontpage-folder-header frontpage-archive-header' });

            if (settings.collapsibleSections) {
                const collapseIcon = archiveHeader.createEl('span', {
                    cls: `frontpage-collapse-icon ${isArchiveCollapsed ? 'is-collapsed' : ''}`,
                    text: '▼'
                });
                archiveHeader.addClass('is-collapsible');
                archiveHeader.addEventListener('click', (e) => {
                    if (e.target.closest('.frontpage-archive-actions')) return;
                    const nowCollapsed = !this.collapsedSections.has(archiveId);
                    if (nowCollapsed) {
                        this.collapsedSections.add(archiveId);
                        archiveSection.addClass('is-collapsed');
                        collapseIcon.addClass('is-collapsed');
                    } else {
                        this.collapsedSections.delete(archiveId);
                        archiveSection.removeClass('is-collapsed');
                        collapseIcon.removeClass('is-collapsed');
                    }
                    this.saveCollapseState();
                });
            }

            const titleWrapper = archiveHeader.createEl('div', { cls: 'frontpage-title-wrapper' });
            titleWrapper.createEl('h2', {
                cls: 'frontpage-folder-title frontpage-archive-title',
                text: '📦 Archive'
            });
            if (settings.showBookmarkCounts) {
                titleWrapper.createEl('span', {
                    cls: 'frontpage-bookmark-count',
                    text: `${archivedBookmarks.length}`
                });
            }

            // Empty archive button
            const archiveActions = archiveHeader.createEl('div', { cls: 'frontpage-archive-actions' });
            const emptyArchiveBtn = archiveActions.createEl('button', {
                cls: 'frontpage-empty-archive-btn',
                attr: { title: 'Empty archive' }
            });
            emptyArchiveBtn.textContent = '🗑️ Empty';
            emptyArchiveBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                new ConfirmModal(
                    this.app,
                    'Empty Archive',
                    `Permanently delete all ${archivedBookmarks.length} archived bookmark${archivedBookmarks.length !== 1 ? 's' : ''}?`,
                    async () => {
                        const count = await this.plugin.emptyArchive();
                        new Notice(`Deleted ${count} archived bookmark${count !== 1 ? 's' : ''}`);
                        this.render();
                    },
                    'Empty Archive',
                    'Cancel',
                    true
                ).open();
            });

            const archiveContent = archiveSection.createEl('div', { cls: 'frontpage-folder-content' });
            const archiveGrid = archiveContent.createEl('div', { cls: 'frontpage-archive-list' });

            // Render archived bookmarks with restore/delete actions
            for (const bookmark of archivedBookmarks) {
                const item = archiveGrid.createEl('div', { cls: 'frontpage-archive-item' });

                const itemInfo = item.createEl('div', { cls: 'frontpage-archive-item-info' });
                itemInfo.createEl('div', { cls: 'frontpage-archive-item-title', text: bookmark.title });

                const archivedDate = new Date(bookmark.archivedAt).toLocaleDateString();
                itemInfo.createEl('div', {
                    cls: 'frontpage-archive-item-date',
                    text: `Archived ${archivedDate}`
                });

                const itemActions = item.createEl('div', { cls: 'frontpage-archive-item-actions' });

                const restoreBtn = itemActions.createEl('button', {
                    cls: 'frontpage-archive-restore-btn',
                    attr: { title: 'Restore bookmark' }
                });
                restoreBtn.textContent = '↩️ Restore';
                restoreBtn.addEventListener('click', async () => {
                    await this.plugin.unarchiveBookmark(bookmark.url);
                    new Notice('Bookmark restored');
                    this.render();
                });

                const deleteBtn = itemActions.createEl('button', {
                    cls: 'frontpage-archive-delete-btn',
                    attr: { title: 'Delete permanently' }
                });
                deleteBtn.textContent = '🗑️';
                deleteBtn.addEventListener('click', async () => {
                    new ConfirmModal(
                        this.app,
                        'Delete Permanently',
                        `Permanently delete "${bookmark.title}"? This cannot be undone.`,
                        async () => {
                            await this.plugin.permanentlyDeleteBookmark(bookmark.url);
                            new Notice('Bookmark deleted permanently');
                            this.render();
                        },
                        'Delete',
                        'Cancel',
                        true
                    ).open();
                });
            }
        }

        // Render batch toolbar when in selection mode
        if (this.selectionMode) {
            this.renderBatchToolbar(contentContainer);
        }
        } catch (error) {
            // Handle render errors gracefully
            console.error('Bookmark Manager: Render error:', error);
            try {
                this.contentEl.empty();
                const errorEl = this.contentEl.createEl('div', { cls: 'frontpage-error' });
                errorEl.createEl('div', { cls: 'frontpage-error-icon', text: '⚠️' });
                errorEl.createEl('p', { text: 'Failed to render bookmarks. Check the console for details.' });
                const retryBtn = errorEl.createEl('button', { cls: 'fp-btn fp-btn-primary', text: 'Retry' });
                retryBtn.addEventListener('click', () => this.render());
            } catch (e) {
                // If even error display fails, just log
                console.error('Bookmark Manager: Failed to display error:', e);
            }
        } finally {
            this._rendering = false;
            if (this._pendingRender) {
                this._pendingRender = false;
                // Schedule next render on next tick to prevent stack overflow
                setTimeout(() => this.render(), 0);
            }
        }
    }

    /**
     * Get the most recently active markdown file
     * Handles sidebar case where getActiveFile() returns null
     * @returns {TFile|null} The markdown file or null
     */
    getActiveMarkdownFile() {
        // First try the tracked current file
        if (this.currentFile && this.currentFile.extension === 'md') {
            return this.currentFile;
        }

        // Try getActiveFile (works when a markdown leaf is focused)
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === 'md') {
            return activeFile;
        }

        // When sidebar is focused, search for a visible markdown view
        const leaves = this.app.workspace.getLeavesOfType('markdown');
        for (const leaf of leaves) {
            const view = leaf.view;
            if (view && view.file && view.file.extension === 'md') {
                return view.file;
            }
        }

        return null;
    }

    /**
     * Get bookmarks that appear in the currently open note
     * @returns {Promise<Array>} Array of bookmark objects found in current note
     */
    async getCurrentNoteBookmarks() {
        const file = this.getActiveMarkdownFile();
        if (!file) {
            return [];
        }

        try {
            const content = await this.app.vault.cachedRead(file);
            // Extract URLs from markdown content
            // Matches http/https URLs with valid domain names (not IPs or template variables)
            const urlRegex = /https?:\/\/[^\s)\]>"']+/g;
            const matches = content.match(urlRegex) || [];

            // Validate and clean URLs
            const cleanedUrls = new Set();
            for (const url of matches) {
                // Remove trailing punctuation that might be picked up
                const cleaned = url.replace(/[.,;:!?]+$/, '');

                // Skip URLs with template variable patterns: {var}, {{var}}, ${var}
                if (/\{[^}]*\}|\$\{[^}]*\}/.test(cleaned)) {
                    continue;
                }

                // Validate URL has a proper domain (not just IP or invalid format)
                if (!this.isValidWebUrl(cleaned)) {
                    continue;
                }

                cleanedUrls.add(cleaned);
            }

            // Find matching bookmarks or create temporary entries for all URLs
            const bookmarks = [];
            const seen = new Set();
            const showAllUrls = this.plugin.settings.showAllCurrentNoteUrls;

            for (const url of cleanedUrls) {
                const normalizedUrl = this.plugin.normalizeUrl(url);
                if (seen.has(normalizedUrl)) continue;
                seen.add(normalizedUrl);

                const bookmark = this.plugin.settings.bookmarks[normalizedUrl];
                if (bookmark) {
                    bookmarks.push(bookmark);
                } else if (showAllUrls) {
                    // Create a temporary bookmark-like object for unsaved URLs
                    const tempBookmark = {
                        id: 'temp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11),
                        title: this.extractTitleFromUrl(url),
                        url: url,
                        description: '',
                        tags: [],
                        createdAt: null,
                        updatedAt: null,
                        clickCount: 0,
                        lastAccessedAt: null,
                        isTemporary: true // Flag to identify unsaved URLs
                    };
                    bookmarks.push(tempBookmark);
                }
            }

            // Sort: unsaved URLs first (for quick triage), then saved bookmarks
            bookmarks.sort((a, b) => {
                if (a.isTemporary && !b.isTemporary) return -1;
                if (!a.isTemporary && b.isTemporary) return 1;
                return 0; // Keep relative order within each group
            });

            return bookmarks;
        } catch (error) {
            console.error('Bookmark Manager: Error reading current note', error);
            return [];
        }
    }

    /**
     * Validate that a URL is a proper web URL with a domain name
     * Rejects IPs, localhost, and malformed URLs
     */
    isValidWebUrl(url) {
        try {
            const parsed = new URL(url);

            // Must be http or https
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return false;
            }

            const hostname = parsed.hostname.toLowerCase();

            // Reject localhost
            if (hostname === 'localhost') {
                return false;
            }

            // Reject IP addresses (IPv4: numbers and dots only)
            if (/^[\d.]+$/.test(hostname)) {
                return false;
            }

            // Reject IPv6 addresses (start with [ or contain :)
            if (hostname.startsWith('[') || hostname.includes(':')) {
                return false;
            }

            // Must have at least one dot (e.g., example.com, not just "server")
            if (!hostname.includes('.')) {
                return false;
            }

            // TLD must be at least 2 characters and only letters
            const parts = hostname.split('.');
            const tld = parts[parts.length - 1];
            if (tld.length < 2 || !/^[a-z]+$/.test(tld)) {
                return false;
            }

            return true;
        } catch {
            return false;
        }
    }

    /**
     * Extract a readable title from a URL
     */
    extractTitleFromUrl(url) {
        try {
            const parsed = new URL(url);
            // Use pathname if meaningful, otherwise use hostname
            let title = parsed.hostname.replace(/^www\./, '');
            if (parsed.pathname && parsed.pathname !== '/') {
                // Get the last meaningful segment of the path
                const segments = parsed.pathname.split('/').filter(s => s);
                if (segments.length > 0) {
                    const lastSegment = segments[segments.length - 1];
                    // Clean up the segment (remove extensions, decode, replace separators)
                    title = decodeURIComponent(lastSegment)
                        .replace(/\.[^.]+$/, '') // Remove file extension
                        .replace(/[-_]/g, ' ') // Replace separators with spaces
                        .replace(/\b\w/g, c => c.toUpperCase()); // Title case
                }
            }
            return title;
        } catch {
            return url;
        }
    }

    openAllBookmarks(bookmarks) {
        if (bookmarks.length === 0) {
            new Notice('No bookmarks to open');
            return;
        }

        const doOpen = () => {
            for (const bookmark of bookmarks) {
                window.open(bookmark.url, '_blank', 'noopener,noreferrer');
            }
            new Notice(`Opened ${bookmarks.length} bookmark${bookmarks.length !== 1 ? 's' : ''}`);
        };

        if (bookmarks.length > CONFIG.OPEN_ALL_CONFIRM_THRESHOLD) {
            // Use non-blocking modal instead of confirm()
            new ConfirmModal(
                this.app,
                'Open Bookmarks',
                `Open ${bookmarks.length} bookmarks in new tabs?`,
                doOpen,
                'Open All',
                'Cancel',
                false
            ).open();
        } else {
            doOpen();
        }
    }

    saveCollapseState() {
        if (this.plugin.settings.persistCollapseState) {
            this.plugin.collapsedState = Array.from(this.collapsedSections);
            // Use saveSettings with immediateRefresh=false to:
            // 1. Go through the save queue to prevent race conditions
            // 2. Avoid triggering a re-render (which would cause an infinite loop)
            this.plugin.saveSettings(false);
        }
    }

    // Get display settings for current view mode
    getViewModeDisplaySettings(settings) {
        const viewMode = settings.viewMode || 'grid';
        const viewModeSettings = settings.viewModeSettings?.[viewMode] || {};

        // Merge with defaults - view mode settings override global settings
        return {
            showFavicons: viewModeSettings.showFavicons ?? settings.showFavicons,
            faviconSize: viewModeSettings.faviconSize ?? settings.faviconSize ?? 'small',
            showUrls: viewModeSettings.showUrls ?? settings.showUrls,
            showDescriptions: viewModeSettings.showDescriptions ?? settings.showDescriptions,
            showTags: viewModeSettings.showTags ?? settings.enableTags
        };
    }

    renderBookmarks(grid, bookmarks, settings, options = {}) {
        const { isSpecialGroup = false, groupName = null, sectionColor = null } = options;

        // Get view-mode-specific display settings
        const displaySettings = this.getViewModeDisplaySettings(settings);
        const normalizedUrl = (url) => this.plugin.normalizeUrl(url);

        for (const bookmark of bookmarks) {
            const bookmarkUrl = normalizedUrl(bookmark.url);
            const isSelected = this.selectedUrls.has(bookmarkUrl);
            const isTemporary = bookmark.isTemporary === true;
            const isSavedInCurrentNote = !isTemporary && groupName === 'Current Note';

            const card = grid.createEl('a', {
                cls: `frontpage-card ${this.selectionMode ? 'is-selectable' : ''} ${isSelected ? 'is-selected' : ''} ${isTemporary ? 'is-temporary' : ''} ${isSavedInCurrentNote ? 'is-current-note-saved' : ''}`,
                href: this.selectionMode ? 'javascript:void(0)' : bookmark.url
            });
            if (!this.selectionMode) {
                card.setAttribute('target', '_blank');
                card.setAttribute('rel', 'noopener noreferrer');
            }
            card.setAttribute('data-title', bookmark.title.toLowerCase());
            card.setAttribute('data-bookmark-url', bookmarkUrl);

            // Apply section color as left border
            if (sectionColor) {
                card.style.borderLeft = `4px solid ${sectionColor}`;
            }
            card.setAttribute('data-url', bookmark.url.toLowerCase());

            // In selection mode, toggle selection on click (only for saved bookmarks)
            if (this.selectionMode && !isTemporary) {
                card.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.toggleBookmarkSelection(bookmarkUrl, card);
                });
            } else if (!isTemporary) {
                // Context menu on right-click (only for saved bookmarks)
                card.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.showBookmarkContextMenu(e, bookmark, isSpecialGroup, groupName);
                });

                // Track click for analytics
                if (settings.enableAnalytics) {
                    card.addEventListener('click', () => {
                        this.plugin.trackBookmarkClick(bookmark.url);
                    });
                }
            }

            // Checkbox for selection mode (shown at top-left, only for saved bookmarks)
            if (this.selectionMode && !isTemporary) {
                const checkbox = card.createEl('div', {
                    cls: `frontpage-card-checkbox ${isSelected ? 'is-checked' : ''}`
                });
                checkbox.createEl('span', { cls: 'frontpage-checkbox-icon', text: isSelected ? '✓' : '' });
            }

            // "Add to bookmarks" button for temporary URLs
            if (isTemporary) {
                const addBtn = card.createEl('button', {
                    cls: 'frontpage-add-bookmark-btn',
                    attr: { title: 'Add to bookmarks' }
                });
                addBtn.createEl('span', { text: '+' });
                addBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // Open the quick add modal pre-filled with this URL
                    new QuickAddBookmarkModal(this.app, this.plugin, {
                        url: bookmark.url,
                        title: bookmark.title
                    }).open();
                });
            }

            const faviconSize = displaySettings.faviconSize;

            // Large favicon header (if large mode)
            if (displaySettings.showFavicons && faviconSize === 'large') {
                const faviconBanner = card.createEl('div', { cls: 'frontpage-favicon-banner' });
                this.loadFavicon(faviconBanner, bookmark.url, 48);
            }

            // Card header with favicon and title
            const cardHeader = card.createEl('div', { cls: 'frontpage-card-header' });

            // Favicon (small or medium)
            if (displaySettings.showFavicons && faviconSize !== 'large') {
                const faviconWrapper = cardHeader.createEl('div', {
                    cls: `frontpage-favicon-wrapper frontpage-favicon-${faviconSize}`
                });
                const iconSize = faviconSize === 'medium' ? 24 : 16;
                this.loadFavicon(faviconWrapper, bookmark.url, iconSize);
            }

            // Title
            cardHeader.createEl('div', { cls: 'frontpage-card-title', text: bookmark.title });

            // Description
            if (displaySettings.showDescriptions && bookmark.description) {
                card.createEl('div', { cls: 'frontpage-card-description', text: bookmark.description });
            }

            // URL (always show for temporary bookmarks so user knows what they're adding)
            if (displaySettings.showUrls || isTemporary) {
                const urlDisplay = this.truncateUrl(bookmark.url, 40);
                card.createEl('div', { cls: 'frontpage-card-url', text: urlDisplay });
            }

            // Tags
            if (displaySettings.showTags && bookmark.tags && bookmark.tags.length > 0) {
                const tagsContainer = card.createEl('div', { cls: 'frontpage-card-tags' });
                for (const tag of bookmark.tags) {
                    tagsContainer.createEl('span', { cls: 'frontpage-tag', text: tag });
                }
            }

            // Status indicator for Current Note section
            if (isTemporary) {
                card.createEl('div', { cls: 'frontpage-temp-indicator', text: 'Not saved' });
            } else if (groupName === 'Current Note') {
                // Show "Saved" badge for saved bookmarks in Current Note section
                card.createEl('div', { cls: 'frontpage-saved-indicator', text: '✓ Saved' });
            }
        }
    }

    toggleSelectionMode() {
        this.selectionMode = !this.selectionMode;
        if (!this.selectionMode) {
            this.selectedUrls.clear();
        }
        this.render();
    }

    toggleBookmarkSelection(url, cardEl) {
        if (this.selectedUrls.has(url)) {
            this.selectedUrls.delete(url);
            cardEl.removeClass('is-selected');
            const checkbox = cardEl.querySelector('.frontpage-card-checkbox');
            if (checkbox) {
                checkbox.removeClass('is-checked');
                const icon = checkbox.querySelector('.frontpage-checkbox-icon');
                if (icon) icon.textContent = '';
            }
        } else {
            this.selectedUrls.add(url);
            cardEl.addClass('is-selected');
            const checkbox = cardEl.querySelector('.frontpage-card-checkbox');
            if (checkbox) {
                checkbox.addClass('is-checked');
                const icon = checkbox.querySelector('.frontpage-checkbox-icon');
                if (icon) icon.textContent = '✓';
            }
        }
        this.updateBatchToolbar();
    }

    updateBatchToolbar() {
        const toolbar = this.contentEl.querySelector('.frontpage-batch-toolbar');
        if (toolbar) {
            const countEl = toolbar.querySelector('.frontpage-batch-count');
            if (countEl) {
                countEl.textContent = `${this.selectedUrls.size} selected`;
            }
            // Show/hide toolbar based on selection
            if (this.selectedUrls.size > 0) {
                toolbar.removeClass('is-hidden');
            } else {
                toolbar.addClass('is-hidden');
            }
        }
    }

    renderBatchToolbar(container) {
        const toolbar = container.createEl('div', {
            cls: `frontpage-batch-toolbar ${this.selectedUrls.size === 0 ? 'is-hidden' : ''}`
        });

        // Selection count
        toolbar.createEl('span', {
            cls: 'frontpage-batch-count',
            text: `${this.selectedUrls.size} selected`
        });

        // Select All button
        const selectAllBtn = toolbar.createEl('button', {
            cls: 'frontpage-batch-btn',
            attr: { title: 'Select all visible bookmarks' }
        });
        selectAllBtn.textContent = 'Select All';
        selectAllBtn.addEventListener('click', () => this.selectAllBookmarks());

        // Add to Favorites button
        const favBtn = toolbar.createEl('button', {
            cls: 'frontpage-batch-btn frontpage-batch-favorite',
            attr: { title: 'Add selected to favorites' }
        });
        favBtn.textContent = '⭐ Favorite';
        favBtn.addEventListener('click', () => this.batchAddToFavorites());

        // Add to Group button
        const groupBtn = toolbar.createEl('button', {
            cls: 'frontpage-batch-btn frontpage-batch-group',
            attr: { title: 'Add selected to group' }
        });
        groupBtn.textContent = '📁 Add to Group';
        groupBtn.addEventListener('click', (e) => this.showBatchGroupMenu(e));

        const settings = this.plugin.settings;

        // Archive button (when enabled)
        if (settings.enableArchive) {
            const archiveBtn = toolbar.createEl('button', {
                cls: 'frontpage-batch-btn frontpage-batch-archive',
                attr: { title: 'Archive selected bookmarks' }
            });
            archiveBtn.textContent = '📦 Archive';
            archiveBtn.addEventListener('click', () => this.batchArchive());
        }

        // Delete button
        const deleteBtn = toolbar.createEl('button', {
            cls: 'frontpage-batch-btn frontpage-batch-delete',
            attr: { title: settings.enableArchive ? 'Permanently delete selected bookmarks' : 'Delete selected bookmarks' }
        });
        deleteBtn.textContent = settings.enableArchive ? '🗑️ Delete Permanently' : '🗑️ Delete';
        deleteBtn.addEventListener('click', () => this.batchDelete());

        return toolbar;
    }

    selectAllBookmarks() {
        const cards = this.contentEl.querySelectorAll('.frontpage-card[data-bookmark-url]');
        for (const card of cards) {
            const url = card.getAttribute('data-bookmark-url');
            if (url && !this.selectedUrls.has(url)) {
                this.selectedUrls.add(url);
                card.addClass('is-selected');
                const checkbox = card.querySelector('.frontpage-card-checkbox');
                if (checkbox) {
                    checkbox.addClass('is-checked');
                    const icon = checkbox.querySelector('.frontpage-checkbox-icon');
                    if (icon) icon.textContent = '✓';
                }
            }
        }
        this.updateBatchToolbar();
    }

    async batchAddToFavorites() {
        if (this.selectedUrls.size === 0) {
            new Notice('No bookmarks selected');
            return;
        }

        let added = 0;
        // Use internal methods for atomic batch operation (single save at end)
        for (const url of this.selectedUrls) {
            if (!this.plugin.isFavorite(url)) {
                if (this.plugin._addToFavoritesInternal(url)) {
                    added++;
                }
            }
        }
        await this.plugin.saveSettings();

        new Notice(`Added ${added} bookmark${added !== 1 ? 's' : ''} to favorites`);
        this.selectionMode = false;
        this.selectedUrls.clear();
        this.render();
    }

    showBatchGroupMenu(event) {
        if (this.selectedUrls.size === 0) {
            new Notice('No bookmarks selected');
            return;
        }

        const menu = new Menu();
        const settings = this.plugin.settings;
        const groupNames = settings.groupOrder || [];

        for (const name of groupNames) {
            menu.addItem((item) => {
                item.setTitle(`${settings.groups[name]?.icon || '📁'} ${name}`)
                    .onClick(async () => {
                        await this.batchAddToGroup(name);
                    });
            });
        }

        menu.addSeparator();

        menu.addItem((item) => {
            item.setTitle('Create New Group...')
                .setIcon('folder-plus')
                .onClick(() => {
                    new CreateGroupModal(this.app, this.plugin, async (result) => {
                        if (result && result.name) {
                            await this.plugin.createGroup(result.name, {
                                icon: result.icon,
                                color: result.color,
                                parentGroup: result.parentGroup
                            });
                            await this.batchAddToGroup(result.name);
                        }
                    }).open();
                });
        });

        menu.showAtMouseEvent(event);
    }

    async batchAddToGroup(groupName) {
        if (this.selectedUrls.size === 0) {
            new Notice('No bookmarks selected');
            return;
        }

        let added = 0;
        // Use internal methods for atomic batch operation (single save at end)
        for (const url of this.selectedUrls) {
            const groups = this.plugin.getBookmarkGroups(url);
            if (!groups.includes(groupName)) {
                if (this.plugin._addToGroupInternal(url, groupName)) {
                    added++;
                }
            }
        }
        await this.plugin.saveSettings();

        new Notice(`Added ${added} bookmark${added !== 1 ? 's' : ''} to "${groupName}"`);
        this.selectionMode = false;
        this.selectedUrls.clear();
        this.render();
    }

    async batchArchive() {
        if (this.selectedUrls.size === 0) {
            new Notice('No bookmarks selected');
            return;
        }

        const count = this.selectedUrls.size;
        // Use internal methods for atomic batch operation (single save at end)
        for (const url of this.selectedUrls) {
            this.plugin._archiveBookmarkInternal(url);
        }
        await this.plugin.saveSettings();
        new Notice(`Archived ${count} bookmark${count !== 1 ? 's' : ''}`);
        this.selectionMode = false;
        this.selectedUrls.clear();
        this.render();
    }

    async batchDelete() {
        if (this.selectedUrls.size === 0) {
            new Notice('No bookmarks selected');
            return;
        }

        const count = this.selectedUrls.size;
        const settings = this.plugin.settings;
        const title = settings.enableArchive ? 'Delete Permanently' : 'Delete Bookmarks';
        const message = settings.enableArchive
            ? `Permanently delete ${count} bookmark${count !== 1 ? 's' : ''}? This cannot be undone.`
            : `Delete ${count} bookmark${count !== 1 ? 's' : ''}? This cannot be undone.`;

        new ConfirmModal(
            this.app,
            title,
            message,
            async () => {
                // Use internal methods for atomic batch operation (single save at end)
                for (const url of this.selectedUrls) {
                    this.plugin._deleteBookmarkInternal(url);
                }
                await this.plugin.saveSettings();
                new Notice(`Deleted ${count} bookmark${count !== 1 ? 's' : ''}`);
                this.selectionMode = false;
                this.selectedUrls.clear();
                this.render();
            },
            'Delete',
            'Cancel',
            true
        ).open();
    }

    showBookmarkContextMenu(event, bookmark, isSpecialGroup, groupName) {
        const menu = new Menu();
        const settings = this.plugin.settings;

        // Copy URL to clipboard
        menu.addItem((item) => {
            item.setTitle('Copy URL')
                .setIcon('copy')
                .onClick(async () => {
                    try {
                        await navigator.clipboard.writeText(bookmark.url);
                        new Notice('URL copied to clipboard');
                    } catch (e) {
                        new Notice('Failed to copy to clipboard');
                    }
                });
        });

        // Copy as markdown link
        menu.addItem((item) => {
            item.setTitle('Copy as Markdown')
                .setIcon('link')
                .onClick(async () => {
                    try {
                        await navigator.clipboard.writeText(`[${bookmark.title}](${bookmark.url})`);
                        new Notice('Markdown link copied to clipboard');
                    } catch (e) {
                        new Notice('Failed to copy to clipboard');
                    }
                });
        });

        // Check single link
        menu.addItem((item) => {
            item.setTitle('Check Link')
                .setIcon('check-circle')
                .onClick(async () => {
                    new Notice('Checking link...');
                    const result = await this.plugin.checkLink(bookmark.url);
                    if (result.ok) {
                        new Notice('Link is working!');
                    } else {
                        new Notice(`Link may be broken: ${result.error}`);
                    }
                });
        });

        menu.addSeparator();

        // Edit bookmark
        menu.addItem((item) => {
            item.setTitle('Edit Bookmark')
                .setIcon('pencil')
                .onClick(() => {
                    new EditBookmarkModal(this.app, this.plugin, bookmark).open();
                });
        });

        menu.addSeparator();

        // Check if already in favorites
        const isInFavorites = this.plugin.isFavorite(bookmark.url);

        if (isInFavorites) {
            menu.addItem((item) => {
                item.setTitle('Remove from Favorites')
                    .setIcon('star-off')
                    .onClick(async () => {
                        await this.plugin.removeFromFavorites(bookmark.url);
                        new Notice('Removed from Favorites');
                    });
            });
        } else {
            menu.addItem((item) => {
                item.setTitle('Add to Favorites')
                    .setIcon('star')
                    .onClick(async () => {
                        await this.plugin.addToFavorites(bookmark.url);
                        new Notice('Added to Favorites');
                    });
            });
        }

        menu.addSeparator();

        // Groups submenu
        const groupNames = settings.groupOrder || [];

        if (groupNames.length > 0) {
            menu.addItem((item) => {
                item.setTitle('Add to Group')
                    .setIcon('folder-plus');

                const submenu = item.setSubmenu();
                for (const name of groupNames) {
                    const isInGroup = settings.groups[name]?.urls?.includes(this.plugin.normalizeUrl(bookmark.url));
                    submenu.addItem((subItem) => {
                        subItem.setTitle(isInGroup ? `✓ ${name}` : name)
                            .onClick(async () => {
                                if (isInGroup) {
                                    await this.plugin.removeFromGroup(bookmark.url, name);
                                    new Notice(`Removed from "${name}"`);
                                } else {
                                    await this.plugin.addToGroup(bookmark.url, name);
                                    new Notice(`Added to "${name}"`);
                                }
                            });
                    });
                }
            });
        }

        // Option to create new group
        menu.addItem((item) => {
            item.setTitle('Add to New Group...')
                .setIcon('folder-plus')
                .onClick(async () => {
                    await this.createGroupAndAdd(bookmark);
                });
        });

        // If in a group, show option to remove
        if (isSpecialGroup && groupName && groupName !== 'Favorites' && groupName !== 'Recently Added' && groupName !== 'Current Note') {
            menu.addSeparator();
            menu.addItem((item) => {
                item.setTitle(`Remove from ${groupName}`)
                    .setIcon('minus-circle')
                    .onClick(async () => {
                        await this.plugin.removeFromGroup(bookmark.url, groupName);
                        new Notice(`Removed from "${groupName}"`);
                    });
            });
        }

        menu.addSeparator();

        // Archive or Delete bookmark
        if (settings.enableArchive) {
            menu.addItem((item) => {
                item.setTitle('Archive Bookmark')
                    .setIcon('archive')
                    .onClick(async () => {
                        await this.plugin.archiveBookmark(bookmark.url);
                        new Notice('Bookmark archived');
                    });
            });
        }

        menu.addItem((item) => {
            item.setTitle(settings.enableArchive ? 'Delete Permanently' : 'Delete Bookmark')
                .setIcon('trash')
                .onClick(() => {
                    new ConfirmModal(
                        this.app,
                        'Delete Bookmark',
                        `Delete "${bookmark.title}"? ${settings.enableArchive ? 'This will permanently delete the bookmark.' : 'This will remove it from all groups and favorites.'}`,
                        async () => {
                            await this.plugin.deleteBookmark(bookmark.url);
                            new Notice('Bookmark deleted');
                        },
                        'Delete',
                        'Cancel',
                        true
                    ).open();
                });
        });

        menu.showAtMouseEvent(event);
    }

    showGroupContextMenu(event, groupName, groupBookmarks) {
        const menu = new Menu();
        const settings = this.plugin.settings;
        const group = settings.groups[groupName];

        // Open all bookmarks in group (if enabled)
        if (this.plugin.settings.showOpenAllButtons) {
            menu.addItem((item) => {
                item.setTitle('Open All Bookmarks')
                    .setIcon('external-link')
                    .onClick(() => {
                        this.openAllBookmarks(groupBookmarks);
                    });
            });
        }

        // Copy all URLs
        menu.addItem((item) => {
            item.setTitle('Copy All URLs')
                .setIcon('copy')
                .onClick(async () => {
                    try {
                        const urls = groupBookmarks.map(b => b.url).join('\n');
                        await navigator.clipboard.writeText(urls);
                        new Notice(`Copied ${groupBookmarks.length} URLs to clipboard`);
                    } catch (e) {
                        new Notice('Failed to copy to clipboard');
                    }
                });
        });

        menu.addSeparator();

        // Collapse/Expand section
        const groupId = `frontpage-group-${groupName.replace(/\s+/g, '-').toLowerCase()}`;
        const isCollapsed = this.collapsedSections.has(groupId);

        menu.addItem((item) => {
            item.setTitle(isCollapsed ? 'Expand Section' : 'Collapse Section')
                .setIcon(isCollapsed ? 'chevron-down' : 'chevron-up')
                .onClick(() => {
                    const section = this.contentEl.querySelector(`#${CSS.escape(groupId)}`);
                    const collapseIcon = section?.querySelector('.frontpage-collapse-icon');
                    if (isCollapsed) {
                        this.collapsedSections.delete(groupId);
                        section?.removeClass('is-collapsed');
                        collapseIcon?.removeClass('is-collapsed');
                    } else {
                        this.collapsedSections.add(groupId);
                        section?.addClass('is-collapsed');
                        collapseIcon?.addClass('is-collapsed');
                    }
                    this.saveCollapseState();
                });
        });

        menu.addSeparator();

        // Edit Group (comprehensive modal for name, icon, color, parent)
        menu.addItem((item) => {
            item.setTitle('Edit Group...')
                .setIcon('settings')
                .onClick(() => {
                    new EditGroupModal(this.app, this.plugin, groupName, async (result) => {
                        // Handle rename if name changed
                        if (result.name !== result.originalName) {
                            const renamed = await this.plugin.renameGroup(result.originalName, result.name);
                            if (!renamed) {
                                new Notice(`Failed to rename group`);
                                return;
                            }
                        }
                        // Update icon and color
                        await this.plugin.updateGroup(result.name, {
                            icon: result.icon,
                            color: result.color
                        });
                        // Update parent if changed
                        const currentParent = this.plugin.getParentGroup(result.name);
                        if (result.parentGroup !== currentParent) {
                            await this.plugin.setParentGroup(result.name, result.parentGroup);
                        }
                        new Notice(`Group "${result.name}" updated`);
                    }).open();
                });
        });

        menu.addSeparator();

        // Quick edit options (for convenience)
        // Change icon
        menu.addItem((item) => {
            item.setTitle('Change Icon')
                .setIcon('palette')
                .onClick(() => {
                    new IconPickerModal(this.app, async (newIcon) => {
                        if (newIcon) {
                            await this.plugin.updateGroup(groupName, { icon: newIcon });
                        }
                    }).open();
                });
        });

        // Change color
        menu.addItem((item) => {
            item.setTitle('Change Color')
                .setIcon('paintbrush')
                .onClick(() => {
                    const colorInput = document.createElement('input');
                    colorInput.type = 'color';
                    colorInput.value = group?.color || '#5090d0';
                    colorInput.addEventListener('change', async (e) => {
                        await this.plugin.updateGroup(groupName, { color: e.target.value });
                    });
                    colorInput.click();
                });
        });

        // Rename group
        menu.addItem((item) => {
            item.setTitle('Rename Group')
                .setIcon('pencil')
                .onClick(() => {
                    new GroupNameModal(this.app, async (newName) => {
                        if (newName && newName.trim() && newName.trim() !== groupName) {
                            const trimmedName = newName.trim();
                            const success = await this.plugin.renameGroup(groupName, trimmedName);
                            if (success) {
                                new Notice(`Renamed group to "${trimmedName}"`);
                            } else {
                                new Notice(`A group named "${trimmedName}" already exists.`);
                            }
                        }
                    }, groupName, 'Rename Group', 'Rename').open();
                });
        });

        // Move up/down
        const groupIdx = settings.groupOrder.indexOf(groupName);
        if (groupIdx > 0) {
            menu.addItem((item) => {
                item.setTitle('Move Up')
                    .setIcon('arrow-up')
                    .onClick(async () => {
                        await this.plugin.moveGroup(groupName, groupIdx - 1);
                    });
            });
        }
        if (groupIdx < settings.groupOrder.length - 1) {
            menu.addItem((item) => {
                item.setTitle('Move Down')
                    .setIcon('arrow-down')
                    .onClick(async () => {
                        await this.plugin.moveGroup(groupName, groupIdx + 1);
                    });
            });
        }

        menu.addSeparator();

        // Sub-group management options
        const isTopLevel = this.plugin.isTopLevelGroup(groupName);
        const isSubGroup = this.plugin.isSubGroup(groupName);
        const hasChildren = this.plugin.getSubGroups(groupName).length > 0;

        // For top-level groups: Add Sub-group
        if (isTopLevel) {
            menu.addItem((item) => {
                item.setTitle('Add Sub-group...')
                    .setIcon('folder-plus')
                    .onClick(() => {
                        new CreateGroupModal(this.app, this.plugin, async (result) => {
                            if (result && result.name) {
                                const created = await this.plugin.createGroup(result.name, {
                                    icon: result.icon,
                                    color: result.color,
                                    parentGroup: groupName
                                });
                                if (created) {
                                    new Notice(`Created sub-group "${result.name}"`);
                                } else {
                                    new Notice(`Could not create sub-group`);
                                }
                            }
                        }, { initialParent: groupName, title: 'Create Sub-group' }).open();
                    });
            });
        }

        // For top-level groups without children: Move to Sub-group of...
        if (isTopLevel && !hasChildren) {
            const otherParents = settings.groupOrder.filter(n =>
                n !== groupName && this.plugin.isTopLevelGroup(n)
            );

            if (otherParents.length > 0) {
                menu.addItem((item) => {
                    item.setTitle('Move to Sub-group of...')
                        .setIcon('corner-down-right');

                    const submenu = item.setSubmenu();
                    for (const parentName of otherParents) {
                        const parentIcon = settings.groups[parentName]?.icon || '📁';
                        submenu.addItem((subItem) => {
                            subItem.setTitle(`${parentIcon} ${parentName}`)
                                .onClick(async () => {
                                    await this.plugin.setParentGroup(groupName, parentName);
                                    new Notice(`Moved "${groupName}" under "${parentName}"`);
                                });
                        });
                    }
                });
            }
        }

        // For sub-groups: Promote to Top-Level
        if (isSubGroup) {
            menu.addItem((item) => {
                item.setTitle('Promote to Top-Level')
                    .setIcon('corner-up-left')
                    .onClick(async () => {
                        await this.plugin.setParentGroup(groupName, null);
                        new Notice(`"${groupName}" is now a top-level group`);
                    });
            });
        }

        menu.addSeparator();

        // Clear all bookmarks from group
        menu.addItem((item) => {
            item.setTitle('Clear All Bookmarks')
                .setIcon('eraser')
                .onClick(() => {
                    new ConfirmModal(
                        this.app,
                        'Clear Bookmarks',
                        `Clear all bookmarks from "${groupName}"? The bookmarks will still exist, just not in this group.`,
                        async () => {
                            settings.groups[groupName].urls = [];
                            await this.plugin.saveSettings();
                            new Notice(`Cleared all bookmarks from "${groupName}"`);
                        },
                        'Clear',
                        'Cancel',
                        true
                    ).open();
                });
        });

        // Delete group
        menu.addItem((item) => {
            item.setTitle('Delete Group')
                .setIcon('trash')
                .onClick(() => {
                    new ConfirmModal(
                        this.app,
                        'Delete Group',
                        `Delete group "${groupName}"? The bookmarks will still exist, just not in this group.`,
                        async () => {
                            await this.plugin.deleteGroup(groupName);
                            new Notice(`Deleted group "${groupName}"`);
                        },
                        'Delete',
                        'Cancel',
                        true
                    ).open();
                });
        });

        menu.showAtMouseEvent(event);
    }

    showFavoritesContextMenu(event) {
        const menu = new Menu();
        const favorites = this.plugin.getFavorites();

        // Open all bookmarks (if enabled)
        if (this.plugin.settings.showOpenAllButtons) {
            menu.addItem((item) => {
                item.setTitle('Open All Bookmarks')
                    .setIcon('external-link')
                    .onClick(() => {
                        this.openAllBookmarks(favorites);
                    });
            });
        }

        // Copy all URLs
        menu.addItem((item) => {
            item.setTitle('Copy All URLs')
                .setIcon('copy')
                .onClick(async () => {
                    try {
                        const urls = favorites.map(b => b.url).join('\n');
                        await navigator.clipboard.writeText(urls);
                        new Notice(`Copied ${favorites.length} URLs to clipboard`);
                    } catch (e) {
                        new Notice('Failed to copy to clipboard');
                    }
                });
        });

        menu.addSeparator();

        // Collapse/Expand section
        const favoritesId = 'frontpage-favorites';
        const isCollapsed = this.collapsedSections.has(favoritesId);

        menu.addItem((item) => {
            item.setTitle(isCollapsed ? 'Expand Section' : 'Collapse Section')
                .setIcon(isCollapsed ? 'chevron-down' : 'chevron-up')
                .onClick(() => {
                    const section = this.contentEl.querySelector(`#${CSS.escape(favoritesId)}`);
                    const collapseIcon = section?.querySelector('.frontpage-collapse-icon');
                    if (isCollapsed) {
                        this.collapsedSections.delete(favoritesId);
                        section?.removeClass('is-collapsed');
                        collapseIcon?.removeClass('is-collapsed');
                    } else {
                        this.collapsedSections.add(favoritesId);
                        section?.addClass('is-collapsed');
                        collapseIcon?.addClass('is-collapsed');
                    }
                    this.saveCollapseState();
                });
        });

        menu.addSeparator();

        // Clear all favorites
        menu.addItem((item) => {
            item.setTitle('Clear All Favorites')
                .setIcon('eraser')
                .onClick(() => {
                    new ConfirmModal(
                        this.app,
                        'Clear Favorites',
                        'Clear all favorites? The bookmarks will still exist, just not in favorites.',
                        async () => {
                            this.plugin.settings.favoriteUrls = [];
                            await this.plugin.saveSettings();
                            new Notice('Cleared all favorites');
                        },
                        'Clear',
                        'Cancel',
                        true
                    ).open();
                });
        });

        menu.showAtMouseEvent(event);
    }

    showRecentlyAddedContextMenu(event) {
        const menu = new Menu();
        const recentlyAdded = this.plugin.getRecentlyAdded();

        // Open all bookmarks (if enabled)
        if (this.plugin.settings.showOpenAllButtons) {
            menu.addItem((item) => {
                item.setTitle('Open All Bookmarks')
                    .setIcon('external-link')
                    .onClick(() => {
                        this.openAllBookmarks(recentlyAdded);
                    });
            });
        }

        // Copy all URLs
        menu.addItem((item) => {
            item.setTitle('Copy All URLs')
                .setIcon('copy')
                .onClick(async () => {
                    try {
                        const urls = recentlyAdded.map(b => b.url).join('\n');
                        await navigator.clipboard.writeText(urls);
                        new Notice(`Copied ${recentlyAdded.length} URLs to clipboard`);
                    } catch (e) {
                        new Notice('Failed to copy to clipboard');
                    }
                });
        });

        menu.addSeparator();

        // Collapse/Expand section
        const recentId = 'frontpage-recently-added';
        const isCollapsed = this.collapsedSections.has(recentId);

        menu.addItem((item) => {
            item.setTitle(isCollapsed ? 'Expand Section' : 'Collapse Section')
                .setIcon(isCollapsed ? 'chevron-down' : 'chevron-up')
                .onClick(() => {
                    // Use scoped query instead of global document.getElementById
                    const section = this.contentEl.querySelector(`#${CSS.escape(recentId)}`);
                    const collapseIcon = section?.querySelector('.frontpage-collapse-icon');
                    if (isCollapsed) {
                        this.collapsedSections.delete(recentId);
                        section?.removeClass('is-collapsed');
                        collapseIcon?.removeClass('is-collapsed');
                    } else {
                        this.collapsedSections.add(recentId);
                        section?.addClass('is-collapsed');
                        collapseIcon?.addClass('is-collapsed');
                    }
                    this.saveCollapseState();
                });
        });

        menu.addSeparator();

        // Clear recently added
        menu.addItem((item) => {
            item.setTitle('Clear Recently Added')
                .setIcon('eraser')
                .onClick(() => {
                    new ConfirmModal(
                        this.app,
                        'Clear Recently Added',
                        'Clear recently added history? The bookmarks will still exist.',
                        async () => {
                            this.plugin.settings.recentlyAddedUrls = [];
                            await this.plugin.saveSettings();
                            new Notice('Cleared recently added');
                        },
                        'Clear',
                        'Cancel',
                        true
                    ).open();
                });
        });

        menu.showAtMouseEvent(event);
    }

    showUncategorizedContextMenu(event, uncategorizedBookmarks) {
        const menu = new Menu();

        // Open all bookmarks (if enabled)
        if (this.plugin.settings.showOpenAllButtons) {
            menu.addItem((item) => {
                item.setTitle('Open All Bookmarks')
                    .setIcon('external-link')
                    .onClick(() => {
                        this.openAllBookmarks(uncategorizedBookmarks);
                    });
            });
        }

        // Copy all URLs
        menu.addItem((item) => {
            item.setTitle('Copy All URLs')
                .setIcon('copy')
                .onClick(async () => {
                    try {
                        const urls = uncategorizedBookmarks.map(b => b.url).join('\n');
                        await navigator.clipboard.writeText(urls);
                        new Notice(`Copied ${uncategorizedBookmarks.length} URLs to clipboard`);
                    } catch (e) {
                        new Notice('Failed to copy to clipboard');
                    }
                });
        });

        menu.addSeparator();

        // Collapse/Expand section
        const uncategorizedId = 'frontpage-uncategorized';
        const isCollapsed = this.collapsedSections.has(uncategorizedId);

        menu.addItem((item) => {
            item.setTitle(isCollapsed ? 'Expand Section' : 'Collapse Section')
                .setIcon(isCollapsed ? 'chevron-down' : 'chevron-up')
                .onClick(() => {
                    const section = this.contentEl.querySelector(`#${CSS.escape(uncategorizedId)}`);
                    const collapseIcon = section?.querySelector('.frontpage-collapse-icon');
                    if (isCollapsed) {
                        this.collapsedSections.delete(uncategorizedId);
                        section?.removeClass('is-collapsed');
                        collapseIcon?.removeClass('is-collapsed');
                    } else {
                        this.collapsedSections.add(uncategorizedId);
                        section?.addClass('is-collapsed');
                        collapseIcon?.addClass('is-collapsed');
                    }
                    this.saveCollapseState();
                });
        });

        menu.addSeparator();

        // Create new group from uncategorized
        menu.addItem((item) => {
            item.setTitle('Move All to New Group...')
                .setIcon('folder-plus')
                .onClick(() => {
                    new CreateGroupModal(this.app, this.plugin, async (result) => {
                        if (result && result.name) {
                            await this.plugin.createGroup(result.name, {
                                icon: result.icon,
                                color: result.color,
                                parentGroup: result.parentGroup
                            });
                            for (const bookmark of uncategorizedBookmarks) {
                                await this.plugin.addToGroup(bookmark.url, result.name);
                            }
                            new Notice(`Moved ${uncategorizedBookmarks.length} bookmarks to "${result.name}"`);
                        }
                    }).open();
                });
        });

        menu.showAtMouseEvent(event);
    }

    // Helper to create a new group and add bookmark to it
    async createGroupAndAdd(bookmark) {
        new CreateGroupModal(this.app, this.plugin, async (result) => {
            if (result && result.name) {
                const created = await this.plugin.createGroup(result.name, {
                    icon: result.icon,
                    color: result.color,
                    parentGroup: result.parentGroup
                });
                if (created) {
                    await this.plugin.addToGroup(bookmark.url, result.name);
                    new Notice(`Created group "${result.name}" and added bookmark`);
                } else {
                    // Group already exists, just add to it
                    await this.plugin.addToGroup(bookmark.url, result.name);
                    new Notice(`Added to existing group "${result.name}"`);
                }
            }
        }).open();
    }

    filterBookmarks(query, settings) {
        if (!this.bookmarksContainer) return;

        const searchQuery = query.toLowerCase().trim();
        const cards = this.bookmarksContainer.querySelectorAll('.frontpage-card');
        const sections = this.bookmarksContainer.querySelectorAll('.frontpage-folder, .frontpage-section');

        // Remove all existing highlights
        cards.forEach(card => {
            const titleEl = card.querySelector('.frontpage-card-title');
            if (titleEl) {
                // Restore original text (remove highlight spans)
                const originalText = titleEl.textContent;
                titleEl.textContent = originalText;
            }
        });

        if (!searchQuery) {
            // Show all cards and sections
            cards.forEach(card => card.style.display = '');
            sections.forEach(section => section.style.display = '');
            if (this.noResultsEl) this.noResultsEl.style.display = 'none';
            return;
        }

        let visibleCount = 0;

        cards.forEach(card => {
            const title = card.getAttribute('data-title') || '';
            const url = card.getAttribute('data-url') || '';
            const description = card.querySelector('.frontpage-card-description')?.textContent?.toLowerCase() || '';
            const tags = Array.from(card.querySelectorAll('.frontpage-tag')).map(t => t.textContent.toLowerCase()).join(' ');

            const matches = title.includes(searchQuery) ||
                           url.includes(searchQuery) ||
                           description.includes(searchQuery) ||
                           tags.includes(searchQuery);

            card.style.display = matches ? '' : 'none';

            if (matches) {
                visibleCount++;

                // Highlight matching text in title (using safe DOM methods to prevent XSS)
                if (settings.highlightSearchResults && title.includes(searchQuery)) {
                    const titleEl = card.querySelector('.frontpage-card-title');
                    if (titleEl) {
                        const originalText = titleEl.textContent;
                        const regex = new RegExp(`(${escapeRegExp(searchQuery)})`, 'gi');
                        const parts = originalText.split(regex);
                        titleEl.empty();
                        for (const part of parts) {
                            if (part.toLowerCase() === searchQuery.toLowerCase()) {
                                titleEl.createEl('mark', { cls: 'frontpage-highlight', text: part });
                            } else if (part) {
                                titleEl.appendText(part);
                            }
                        }
                    }
                }
            }
        });

        // Hide sections that have no visible cards
        sections.forEach(section => {
            const visibleCards = section.querySelectorAll('.frontpage-card[style=""], .frontpage-card:not([style])');
            const hasVisibleCards = Array.from(visibleCards).some(card => card.style.display !== 'none');
            section.style.display = hasVisibleCards ? '' : 'none';
        });

        // Show/hide no results message
        if (this.noResultsEl) {
            this.noResultsEl.style.display = visibleCount === 0 ? 'flex' : 'none';
        }
    }

    /**
     * Smart Paste: Read URL from clipboard, fetch metadata, and open pre-filled add modal
     * @param {HTMLElement} button - The paste button element for loading state
     */
    async smartPasteBookmark(button) {
        const originalText = button.querySelector('.btn-text')?.textContent || 'Paste';
        const btnIcon = button.querySelector('.btn-icon');
        const btnText = button.querySelector('.btn-text');

        try {
            // Show loading state
            button.disabled = true;
            if (btnIcon) btnIcon.textContent = '⏳';
            if (btnText) btnText.textContent = 'Loading...';

            // Read clipboard
            let clipboardText;
            try {
                clipboardText = await navigator.clipboard.readText();
            } catch (err) {
                new Notice('Unable to read clipboard. Please paste the URL manually.');
                return;
            }

            const url = clipboardText.trim();

            // Validate URL
            if (!url) {
                new Notice('Clipboard is empty');
                return;
            }

            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                new Notice('Clipboard does not contain a valid URL');
                return;
            }

            // Check for duplicates
            const normalizedUrl = this.plugin.normalizeUrl(url);
            if (this.plugin.settings.bookmarks[normalizedUrl]) {
                new Notice('This bookmark already exists');
                return;
            }

            // Fetch metadata
            const metadata = await this.plugin.extractMetadataFromUrl(url);

            // Open modal with pre-filled data
            new QuickAddBookmarkModal(this.app, this.plugin, {
                url: url,
                title: metadata.title || '',
                description: metadata.description || '',
                group: this.plugin.settings.smartPasteDefaultGroup || ''
            }).open();

            if (metadata.success) {
                new Notice('Metadata extracted! Review and save the bookmark.');
            } else {
                new Notice('Could not fetch page info. Please enter the title manually.');
            }

        } catch (error) {
            console.error('Smart paste error:', error);
            new Notice('Error reading clipboard');
        } finally {
            // Reset button state
            button.disabled = false;
            if (btnIcon) btnIcon.textContent = '📋';
            if (btnText) btnText.textContent = originalText;
        }
    }

    /**
     * Render the tag cloud section
     * @param {HTMLElement} container - Container to render into
     * @param {Object} settings - Plugin settings
     */
    renderTagCloud(container, settings) {
        const allTags = this.plugin.getAllTags();
        if (allTags.size === 0) return;

        const tagCloudId = 'frontpage-tag-cloud';
        const isTagCloudCollapsed = this.collapsedSections.has(tagCloudId);

        const tagCloudSection = container.createEl('div', {
            cls: `frontpage-folder frontpage-special-group frontpage-tag-cloud-group ${isTagCloudCollapsed ? 'is-collapsed' : ''}`,
            attr: { id: tagCloudId }
        });

        const tagCloudHeader = tagCloudSection.createEl('div', { cls: 'frontpage-folder-header' });
        const titleWrapper = tagCloudHeader.createEl('div', { cls: 'frontpage-title-wrapper' });
        titleWrapper.createEl('h2', {
            cls: 'frontpage-folder-title frontpage-tag-cloud-title',
            text: '🏷️ Tags'
        });
        if (settings.showBookmarkCounts) {
            titleWrapper.createEl('span', {
                cls: 'frontpage-bookmark-count',
                text: `${allTags.size}`
            });
        }

        // Add collapse icon and functionality if collapsible sections enabled
        if (settings.collapsibleSections) {
            const collapseIcon = tagCloudHeader.createEl('span', {
                cls: `frontpage-collapse-icon ${isTagCloudCollapsed ? 'is-collapsed' : ''}`,
                text: '▼'
            });
            tagCloudHeader.addClass('is-collapsible');
            tagCloudHeader.addEventListener('click', (e) => {
                // Don't collapse when clicking clear filters button
                if (e.target.closest('.frontpage-tag-clear-btn')) return;

                const nowCollapsed = !this.collapsedSections.has(tagCloudId);
                if (nowCollapsed) {
                    this.collapsedSections.add(tagCloudId);
                    tagCloudSection.addClass('is-collapsed');
                    collapseIcon.addClass('is-collapsed');
                } else {
                    this.collapsedSections.delete(tagCloudId);
                    tagCloudSection.removeClass('is-collapsed');
                    collapseIcon.removeClass('is-collapsed');
                }
                this.saveCollapseState();
            });
        }

        // Add clear filters button if filters are active
        if (this.activeTagFilters.size > 0) {
            const clearBtn = tagCloudHeader.createEl('button', {
                cls: 'frontpage-tag-clear-btn',
                text: '✕ Clear filters'
            });
            clearBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent collapse toggle
                this.activeTagFilters.clear();
                this.render();
            });
        }

        const tagCloudContent = tagCloudSection.createEl('div', { cls: 'frontpage-folder-content' });
        const tagCloud = tagCloudContent.createEl('div', { cls: 'frontpage-tag-cloud' });

        // Sort tags alphabetically
        const sortedTags = Array.from(allTags.entries()).sort((a, b) => a[0].localeCompare(b[0]));

        for (const [tag, count] of sortedTags) {
            const isActive = this.activeTagFilters.has(tag);
            const tagEl = tagCloud.createEl('button', {
                cls: `frontpage-tag-cloud-item ${isActive ? 'is-active' : ''}`,
                attr: { 'data-tag': tag }
            });
            tagEl.createEl('span', { cls: 'frontpage-tag-cloud-name', text: tag });
            tagEl.createEl('span', { cls: 'frontpage-tag-cloud-count', text: `${count}` });

            tagEl.addEventListener('click', () => {
                if (this.activeTagFilters.has(tag)) {
                    this.activeTagFilters.delete(tag);
                } else {
                    this.activeTagFilters.add(tag);
                }
                this.render();
            });

            // Right-click for options
            tagEl.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.showTagContextMenu(e, tag);
            });
        }
    }

    /**
     * Show context menu for a tag
     * @param {MouseEvent} e - Mouse event
     * @param {string} tag - Tag name
     */
    showTagContextMenu(e, tag) {
        const menu = new Menu();

        menu.addItem(item => {
            item.setTitle(`Filter by "${tag}"`)
                .setIcon('search')
                .onClick(() => {
                    this.activeTagFilters.clear();
                    this.activeTagFilters.add(tag);
                    this.render();
                });
        });

        if (this.activeTagFilters.size > 0) {
            menu.addItem(item => {
                item.setTitle('Clear all filters')
                    .setIcon('x')
                    .onClick(() => {
                        this.activeTagFilters.clear();
                        this.render();
                    });
            });
        }

        menu.addSeparator();

        menu.addItem(item => {
            item.setTitle('Save as Collection...')
                .setIcon('folder-plus')
                .onClick(() => {
                    new SaveCollectionModal(this.app, this.plugin, [tag]).open();
                });
        });

        menu.showAtMouseEvent(e);
    }

    /**
     * Show context menu for a collection
     * @param {MouseEvent} e - Mouse event
     * @param {string} name - Collection name
     * @param {string[]} tags - Collection tags
     */
    showCollectionContextMenu(e, name, tags) {
        const menu = new Menu();

        menu.addItem(item => {
            item.setTitle('Filter by these tags')
                .setIcon('search')
                .onClick(() => {
                    this.activeTagFilters.clear();
                    for (const tag of tags) {
                        this.activeTagFilters.add(tag);
                    }
                    this.render();
                });
        });

        menu.addSeparator();

        menu.addItem(item => {
            item.setTitle('Rename collection')
                .setIcon('pencil')
                .onClick(() => {
                    new RenameCollectionModal(this.app, this.plugin, name).open();
                });
        });

        menu.addItem(item => {
            item.setTitle('Delete collection')
                .setIcon('trash')
                .onClick(async () => {
                    await this.plugin.deleteCollection(name);
                    new Notice(`Collection "${name}" deleted`);
                    this.render();
                });
        });

        menu.showAtMouseEvent(e);
    }

    /**
     * Get bookmarks filtered by active tag filters
     * @param {Object[]} bookmarks - Bookmarks to filter
     * @returns {Object[]} Filtered bookmarks
     */
    filterBookmarksByTags(bookmarks) {
        if (this.activeTagFilters.size === 0) {
            return bookmarks;
        }

        const mode = this.plugin.settings.tagFilterMode || 'AND';
        const filterTags = Array.from(this.activeTagFilters).map(t => t.toLowerCase());

        return bookmarks.filter(bookmark => {
            if (!Array.isArray(bookmark.tags) || bookmark.tags.length === 0) {
                return false;
            }
            const bookmarkTags = bookmark.tags.map(t => t.toLowerCase());

            if (mode === 'AND') {
                return filterTags.every(tag => bookmarkTags.includes(tag));
            } else {
                return filterTags.some(tag => bookmarkTags.includes(tag));
            }
        });
    }

    collapseAll() {
        const sections = this.bookmarksContainer?.querySelectorAll('.frontpage-folder, .frontpage-section');
        sections?.forEach(section => {
            const id = section.id;
            if (id) {
                this.collapsedSections.add(id);
                section.addClass('is-collapsed');
                const icon = section.querySelector('.frontpage-collapse-icon');
                icon?.addClass('is-collapsed');
            }
        });
        this.saveCollapseState();
    }

    expandAll() {
        const sections = this.bookmarksContainer?.querySelectorAll('.frontpage-folder, .frontpage-section');
        sections?.forEach(section => {
            const id = section.id;
            if (id) {
                this.collapsedSections.delete(id);
                section.removeClass('is-collapsed');
                const icon = section.querySelector('.frontpage-collapse-icon');
                icon?.removeClass('is-collapsed');
            }
        });
        this.saveCollapseState();
    }

    /**
     * Truncate a URL for display
     */
    truncateUrl(url, maxLength = 40) {
        try {
            const parsed = new URL(url);
            let display = parsed.hostname;
            if (parsed.pathname && parsed.pathname !== '/') {
                display += parsed.pathname;
            }
            if (display.length > maxLength) {
                return display.substring(0, maxLength - 3) + '...';
            }
            return display;
        } catch {
            if (url.length > maxLength) {
                return url.substring(0, maxLength - 3) + '...';
            }
            return url;
        }
    }

    /**
     * Queue a favicon to be lazy-loaded when visible
     */
    loadFavicon(wrapper, url, size = 16) {
        wrapper.dataset.faviconUrl = url;
        wrapper.dataset.faviconSize = size;
        wrapper.addClass('frontpage-favicon-placeholder');
        this.faviconObserver.observe(wrapper);
    }

    /**
     * Actually load and display a favicon
     */
    loadFaviconNow(wrapper, url, size = 16) {
        wrapper.removeClass('frontpage-favicon-placeholder');

        try {
            const parsed = new URL(url);
            const cacheKey = parsed.hostname;

            // Check cache first
            if (this.faviconCache.has(cacheKey)) {
                const cachedSrc = this.faviconCache.get(cacheKey);
                if (cachedSrc) {
                    const img = wrapper.createEl('img', {
                        cls: 'frontpage-favicon',
                        attr: { src: cachedSrc, width: size, height: size, alt: '' }
                    });
                    img.addEventListener('error', () => {
                        img.remove();
                        wrapper.createEl('span', { cls: 'frontpage-favicon-fallback', text: '🔗' });
                    });
                } else {
                    wrapper.createEl('span', { cls: 'frontpage-favicon-fallback', text: '🔗' });
                }
                return;
            }

            // Try Google favicon service
            const faviconUrl = `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=${size * 2}`;

            const img = wrapper.createEl('img', {
                cls: 'frontpage-favicon',
                attr: { src: faviconUrl, width: size, height: size, alt: '' }
            });

            img.addEventListener('load', () => {
                // Cache successful loads
                if (this.faviconCache.size >= this.faviconCacheMaxSize) {
                    // Remove oldest entry
                    const firstKey = this.faviconCache.keys().next().value;
                    this.faviconCache.delete(firstKey);
                }
                this.faviconCache.set(cacheKey, faviconUrl);
            });

            img.addEventListener('error', () => {
                img.remove();
                wrapper.createEl('span', { cls: 'frontpage-favicon-fallback', text: '🔗' });
                // Cache failures too
                if (this.faviconCache.size >= this.faviconCacheMaxSize) {
                    const firstKey = this.faviconCache.keys().next().value;
                    this.faviconCache.delete(firstKey);
                }
                this.faviconCache.set(cacheKey, null);
            });
        } catch {
            wrapper.createEl('span', { cls: 'frontpage-favicon-fallback', text: '🔗' });
        }
    }

    onClose() {
        // Clean up render-time event listeners to prevent memory leaks
        if (this._renderAbortController) {
            this._renderAbortController.abort();
            this._renderAbortController = null;
        }
        // Clean up the IntersectionObserver
        if (this.faviconObserver) {
            this.faviconObserver.disconnect();
        }
        // Clean up the ResizeObserver
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        // Clean up pending resize animation frame
        if (this._resizeRAF) {
            cancelAnimationFrame(this._resizeRAF);
        }
        // Clean up the scroll observer (for sticky controls bar)
        if (this.scrollObserver) {
            this.scrollObserver.disconnect();
        }
        // Clear favicon cache to free memory
        if (this.faviconCache) {
            this.faviconCache.clear();
        }
    }
}

// ========== MODAL CLASSES ==========

class GroupNameModal extends Modal {
    constructor(app, onSubmit, initialValue = '', title = 'Enter Group Name', buttonText = 'Create') {
        super(app);
        this.onSubmit = onSubmit;
        this.initialValue = initialValue;
        this.title = title;
        this.buttonText = buttonText;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: this.title });

        const inputEl = contentEl.createEl('input', {
            cls: 'frontpage-modal-input',
            attr: { type: 'text', placeholder: 'Group name' }
        });
        inputEl.value = this.initialValue;
        inputEl.focus();
        inputEl.select();

        const buttonContainer = contentEl.createEl('div', { cls: 'frontpage-modal-buttons' });

        const submitBtn = buttonContainer.createEl('button', {
            cls: 'mod-cta',
            text: this.buttonText
        });
        submitBtn.addEventListener('click', () => {
            const value = inputEl.value.trim();
            if (!value) {
                new Notice('Please enter a name');
                return;
            }
            this.onSubmit(value);
            this.close();
        });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => {
            this.close();
        });

        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const value = inputEl.value.trim();
                if (!value) {
                    new Notice('Please enter a name');
                    return;
                }
                this.onSubmit(value);
                this.close();
            } else if (e.key === 'Escape') {
                this.close();
            }
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

class ConfirmModal extends Modal {
    constructor(app, title, message, onConfirm, confirmText = 'Confirm', cancelText = 'Cancel', isDanger = false) {
        super(app);
        this.title = title;
        this.message = message;
        this.onConfirm = onConfirm;
        this.confirmText = confirmText;
        this.cancelText = cancelText;
        this.isDanger = isDanger;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: this.title });
        contentEl.createEl('p', { text: this.message });

        const buttonContainer = contentEl.createEl('div', { cls: 'frontpage-modal-buttons' });

        const confirmBtn = buttonContainer.createEl('button', {
            cls: this.isDanger ? 'mod-warning' : 'mod-cta',
            text: this.confirmText
        });
        confirmBtn.addEventListener('click', () => {
            this.onConfirm();
            this.close();
        });

        const cancelBtn = buttonContainer.createEl('button', { text: this.cancelText });
        cancelBtn.addEventListener('click', () => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Interactive tag input with autocomplete suggestions
 * Shows existing tags as user types, displays selected tags as removable pills
 */
class TagAutocompleteInput {
    constructor(container, plugin, initialTags = [], options = {}) {
        this.container = container;
        this.plugin = plugin;
        this.selectedTags = new Set(initialTags);
        this.options = {
            placeholder: 'Type to add tags...',
            maxSuggestions: 8,
            ...options
        };
        this.highlightedIndex = -1;
        this.suggestions = [];
        this.render();
    }

    render() {
        // Main wrapper
        this.wrapper = this.container.createEl('div', { cls: 'frontpage-tag-autocomplete' });

        // Pills container (also contains the input)
        this.pillsContainer = this.wrapper.createEl('div', { cls: 'frontpage-tag-pills' });

        // Render initial tags as pills
        for (const tag of this.selectedTags) {
            this.createPill(tag);
        }

        // Text input
        this.input = this.pillsContainer.createEl('input', {
            cls: 'frontpage-tag-input-field',
            attr: {
                type: 'text',
                placeholder: this.selectedTags.size === 0 ? this.options.placeholder : ''
            }
        });

        // Dropdown for suggestions
        this.dropdown = this.wrapper.createEl('div', { cls: 'frontpage-tag-dropdown' });

        // Event listeners
        this.input.addEventListener('input', () => this.onInputChange());
        this.input.addEventListener('keydown', (e) => this.handleKeydown(e));
        this.input.addEventListener('focus', () => this.onInputChange());
        this.input.addEventListener('blur', () => {
            // Delay to allow click on suggestion
            setTimeout(() => this.hideDropdown(), 150);
        });

        // Click on pills container focuses input
        this.pillsContainer.addEventListener('click', (e) => {
            if (e.target === this.pillsContainer) {
                this.input.focus();
            }
        });
    }

    createPill(tag) {
        const pill = document.createElement('span');
        pill.className = 'frontpage-tag-pill';
        pill.setAttribute('data-tag', tag);

        const text = document.createElement('span');
        text.textContent = tag;
        pill.appendChild(text);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'frontpage-tag-pill-remove';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.removeTag(tag);
        });
        pill.appendChild(removeBtn);

        // Insert before input
        this.pillsContainer.insertBefore(pill, this.input);
        return pill;
    }

    getTags() {
        return Array.from(this.selectedTags);
    }

    addTag(tag) {
        const normalizedTag = tag.trim();
        if (!normalizedTag || this.selectedTags.has(normalizedTag)) {
            return;
        }

        this.selectedTags.add(normalizedTag);
        this.createPill(normalizedTag);
        this.input.value = '';
        this.input.placeholder = '';
        this.hideDropdown();
        this.input.focus();
    }

    removeTag(tag) {
        this.selectedTags.delete(tag);
        const pill = this.pillsContainer.querySelector(`[data-tag="${CSS.escape(tag)}"]`);
        if (pill) {
            pill.remove();
        }
        if (this.selectedTags.size === 0) {
            this.input.placeholder = this.options.placeholder;
        }
        this.input.focus();
    }

    onInputChange() {
        const query = this.input.value.trim().toLowerCase();
        this.updateSuggestions(query);
    }

    updateSuggestions(query) {
        const allTags = this.plugin.getAllTags();

        // Filter tags that match query and aren't already selected
        let matches = [];
        for (const [tag, count] of allTags.entries()) {
            if (!this.selectedTags.has(tag)) {
                if (!query || tag.toLowerCase().includes(query)) {
                    matches.push({ tag, count, isExact: tag.toLowerCase() === query });
                }
            }
        }

        // Sort: exact matches first, then by count (desc), then alphabetically
        matches.sort((a, b) => {
            if (a.isExact && !b.isExact) return -1;
            if (!a.isExact && b.isExact) return 1;
            if (b.count !== a.count) return b.count - a.count;
            return a.tag.localeCompare(b.tag);
        });

        // Limit suggestions
        matches = matches.slice(0, this.options.maxSuggestions);

        // Check if we should show "create new tag" option
        const showCreateNew = query && !matches.some(m => m.tag.toLowerCase() === query);

        this.suggestions = matches;
        this.highlightedIndex = -1;

        // Render dropdown
        this.dropdown.empty();

        if (matches.length === 0 && !showCreateNew) {
            this.hideDropdown();
            return;
        }

        for (let i = 0; i < matches.length; i++) {
            const { tag, count } = matches[i];
            const item = this.dropdown.createEl('div', { cls: 'frontpage-tag-suggestion' });
            item.setAttribute('data-index', String(i));

            item.createEl('span', { cls: 'frontpage-tag-suggestion-name', text: tag });
            item.createEl('span', { cls: 'frontpage-tag-suggestion-count', text: String(count) });

            item.addEventListener('mouseenter', () => this.setHighlight(i));
            item.addEventListener('click', () => this.addTag(tag));
        }

        // Add "create new" option if query doesn't match existing tag
        if (showCreateNew) {
            const createIndex = matches.length;
            const createItem = this.dropdown.createEl('div', {
                cls: 'frontpage-tag-suggestion frontpage-tag-suggestion-new'
            });
            createItem.setAttribute('data-index', String(createIndex));
            createItem.createEl('span', { text: `Create "${this.input.value.trim()}"` });

            createItem.addEventListener('mouseenter', () => this.setHighlight(createIndex));
            createItem.addEventListener('click', () => this.addTag(this.input.value.trim()));

            this.suggestions.push({ tag: this.input.value.trim(), count: 0, isNew: true });
        }

        this.showDropdown();
    }

    setHighlight(index) {
        // Remove previous highlight
        const items = this.dropdown.querySelectorAll('.frontpage-tag-suggestion');
        items.forEach(item => item.removeClass('is-highlighted'));

        // Set new highlight
        this.highlightedIndex = index;
        if (index >= 0 && index < items.length) {
            items[index].addClass('is-highlighted');
        }
    }

    handleKeydown(e) {
        const items = this.dropdown.querySelectorAll('.frontpage-tag-suggestion');

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                if (items.length > 0) {
                    const newIndex = this.highlightedIndex < items.length - 1
                        ? this.highlightedIndex + 1
                        : 0;
                    this.setHighlight(newIndex);
                }
                break;

            case 'ArrowUp':
                e.preventDefault();
                if (items.length > 0) {
                    const newIndex = this.highlightedIndex > 0
                        ? this.highlightedIndex - 1
                        : items.length - 1;
                    this.setHighlight(newIndex);
                }
                break;

            case 'Enter':
                e.preventDefault();
                if (this.highlightedIndex >= 0 && this.highlightedIndex < this.suggestions.length) {
                    this.addTag(this.suggestions[this.highlightedIndex].tag);
                } else if (this.input.value.trim()) {
                    this.addTag(this.input.value.trim());
                }
                break;

            case 'Escape':
                this.hideDropdown();
                break;

            case 'Backspace':
                if (this.input.value === '' && this.selectedTags.size > 0) {
                    // Remove last tag
                    const tags = Array.from(this.selectedTags);
                    this.removeTag(tags[tags.length - 1]);
                }
                break;

            case 'Tab':
                // Accept current input as tag if there's text
                if (this.input.value.trim()) {
                    e.preventDefault();
                    this.addTag(this.input.value.trim());
                }
                break;
        }
    }

    showDropdown() {
        // Position dropdown using fixed positioning to escape modal overflow
        const rect = this.pillsContainer.getBoundingClientRect();
        this.dropdown.style.position = 'fixed';
        this.dropdown.style.top = `${rect.bottom + 4}px`;
        this.dropdown.style.left = `${rect.left}px`;
        this.dropdown.style.width = `${rect.width}px`;
        this.dropdown.addClass('is-visible');
    }

    hideDropdown() {
        this.dropdown.removeClass('is-visible');
        this.highlightedIndex = -1;
    }

    destroy() {
        this.wrapper.remove();
    }
}

/**
 * Combobox input for selecting or creating a group
 * Shows existing groups with hierarchy, allows inline creation with icon/color/parent
 */
class GroupComboboxInput {
    constructor(container, plugin, options = {}) {
        this.container = container;
        this.plugin = plugin;
        this.options = {
            placeholder: 'Select or create group...',
            maxSuggestions: 10,
            ...options
        };
        this.selectedGroup = options.initialValue || null;
        this.isCreatingNew = false;
        this.newGroupData = {
            name: '',
            icon: '📁',
            color: '',
            parentGroup: null
        };
        this.highlightedIndex = -1;
        this.suggestions = [];
        this.render();
    }

    render() {
        // Main wrapper
        this.wrapper = this.container.createEl('div', { cls: 'frontpage-group-combobox' });

        // Input wrapper with clear button
        this.inputWrapper = this.wrapper.createEl('div', { cls: 'frontpage-group-combobox-input-wrapper' });

        // Text input
        this.input = this.inputWrapper.createEl('input', {
            cls: 'frontpage-group-combobox-input frontpage-modal-input',
            attr: {
                type: 'text',
                placeholder: this.options.placeholder
            }
        });

        if (this.selectedGroup) {
            const group = this.plugin.settings.groups[this.selectedGroup];
            this.input.value = group ? `${group.icon || '📁'} ${this.selectedGroup}` : this.selectedGroup;
        }

        // Clear button
        this.clearBtn = this.inputWrapper.createEl('button', {
            cls: 'frontpage-group-combobox-clear',
            attr: { type: 'button', 'aria-label': 'Clear selection' }
        });
        this.clearBtn.textContent = '×';
        this.clearBtn.style.display = this.selectedGroup ? 'block' : 'none';

        // Dropdown for suggestions
        this.dropdown = this.wrapper.createEl('div', { cls: 'frontpage-group-combobox-dropdown' });

        // Inline creator (hidden initially)
        this.creatorEl = this.wrapper.createEl('div', { cls: 'frontpage-group-creator' });
        this.creatorEl.style.display = 'none';

        // Event listeners
        this.input.addEventListener('input', () => this.onInputChange());
        this.input.addEventListener('keydown', (e) => this.handleKeydown(e));
        this.input.addEventListener('focus', () => {
            if (!this.isCreatingNew) {
                this.onInputChange();
            }
        });
        this.input.addEventListener('blur', () => {
            // Delay to allow click on suggestion
            setTimeout(() => this.hideDropdown(), 150);
        });

        this.clearBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.clearSelection();
        });
    }

    clearSelection() {
        this.selectedGroup = null;
        this.isCreatingNew = false;
        this.newGroupData = { name: '', icon: '📁', color: '', parentGroup: null };
        this.input.value = '';
        this.input.placeholder = this.options.placeholder;
        this.clearBtn.style.display = 'none';
        this.creatorEl.style.display = 'none';
        this.input.focus();
    }

    onInputChange() {
        const query = this.input.value.trim().toLowerCase();
        this.updateSuggestions(query);
    }

    updateSuggestions(query) {
        // Get hierarchical group order
        const hierarchicalGroups = this.plugin.getHierarchicalGroupOrder();

        // Filter groups that match query
        let matches = [];
        for (const entry of hierarchicalGroups) {
            const group = this.plugin.settings.groups[entry.name];
            if (!group) continue;

            const displayName = entry.name.toLowerCase();
            if (!query || displayName.includes(query)) {
                matches.push({
                    name: entry.name,
                    icon: group.icon || '📁',
                    isSubGroup: entry.isSubGroup,
                    parent: entry.parent,
                    isExact: displayName === query
                });
            }
        }

        // Sort: exact matches first, then by hierarchy
        matches.sort((a, b) => {
            if (a.isExact && !b.isExact) return -1;
            if (!a.isExact && b.isExact) return 1;
            return 0;
        });

        // Limit suggestions
        matches = matches.slice(0, this.options.maxSuggestions);

        // Check if we should show "create new" option
        const exactMatch = matches.some(m => m.name.toLowerCase() === query);
        const showCreateNew = query && !exactMatch;

        this.suggestions = matches;
        this.highlightedIndex = -1;

        // Render dropdown
        this.dropdown.empty();

        if (matches.length === 0 && !showCreateNew) {
            this.hideDropdown();
            return;
        }

        for (let i = 0; i < matches.length; i++) {
            const { name, icon, isSubGroup } = matches[i];
            const item = this.dropdown.createEl('div', {
                cls: `frontpage-group-suggestion ${isSubGroup ? 'is-subgroup' : ''}`
            });
            item.setAttribute('data-index', String(i));

            const prefix = isSubGroup ? '└ ' : '';
            item.createEl('span', { cls: 'frontpage-group-suggestion-icon', text: icon });
            item.createEl('span', { cls: 'frontpage-group-suggestion-name', text: `${prefix}${name}` });

            item.addEventListener('mouseenter', () => this.setHighlight(i));
            item.addEventListener('click', () => this.selectGroup(name));
        }

        // Add "create new" option if query doesn't match existing
        if (showCreateNew) {
            const createIndex = matches.length;
            const rawQuery = this.input.value.trim();

            // Add separator if there are existing matches
            if (matches.length > 0) {
                this.dropdown.createEl('div', { cls: 'frontpage-group-suggestion-separator' });
            }

            const createItem = this.dropdown.createEl('div', {
                cls: 'frontpage-group-suggestion frontpage-group-suggestion-create'
            });
            createItem.setAttribute('data-index', String(createIndex));
            createItem.createEl('span', { cls: 'frontpage-group-suggestion-icon', text: '➕' });
            createItem.createEl('span', { text: `Create "${rawQuery}"` });

            createItem.addEventListener('mouseenter', () => this.setHighlight(createIndex));
            createItem.addEventListener('click', () => this.startNewGroupCreation(rawQuery));

            this.suggestions.push({ name: rawQuery, icon: '📁', isNew: true });
        }

        this.showDropdown();
    }

    setHighlight(index) {
        const items = this.dropdown.querySelectorAll('.frontpage-group-suggestion');
        items.forEach(item => item.removeClass('is-highlighted'));

        this.highlightedIndex = index;
        if (index >= 0 && index < items.length) {
            items[index].addClass('is-highlighted');
        }
    }

    handleKeydown(e) {
        const items = this.dropdown.querySelectorAll('.frontpage-group-suggestion');

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                if (items.length > 0) {
                    const newIndex = this.highlightedIndex < items.length - 1
                        ? this.highlightedIndex + 1
                        : 0;
                    this.setHighlight(newIndex);
                }
                break;

            case 'ArrowUp':
                e.preventDefault();
                if (items.length > 0) {
                    const newIndex = this.highlightedIndex > 0
                        ? this.highlightedIndex - 1
                        : items.length - 1;
                    this.setHighlight(newIndex);
                }
                break;

            case 'Enter':
                e.preventDefault();
                if (this.highlightedIndex >= 0 && this.highlightedIndex < this.suggestions.length) {
                    const suggestion = this.suggestions[this.highlightedIndex];
                    if (suggestion.isNew) {
                        this.startNewGroupCreation(suggestion.name);
                    } else {
                        this.selectGroup(suggestion.name);
                    }
                }
                break;

            case 'Escape':
                this.hideDropdown();
                break;
        }
    }

    selectGroup(name) {
        const group = this.plugin.settings.groups[name];
        if (!group) return;

        this.selectedGroup = name;
        this.isCreatingNew = false;
        this.input.value = `${group.icon || '📁'} ${name}`;
        this.clearBtn.style.display = 'block';
        this.creatorEl.style.display = 'none';
        this.hideDropdown();
    }

    startNewGroupCreation(name) {
        this.isCreatingNew = true;
        this.selectedGroup = null;
        this.newGroupData = {
            name: name,
            icon: '📁',
            color: '',
            parentGroup: null
        };

        this.input.value = name;
        this.clearBtn.style.display = 'block';
        this.hideDropdown();
        this.renderCreator();
    }

    renderCreator() {
        this.creatorEl.empty();
        this.creatorEl.style.display = 'block';

        // Header
        const header = this.creatorEl.createEl('div', { cls: 'frontpage-group-creator-header' });
        header.createEl('span', { text: `Creating: "${this.newGroupData.name}"` });

        // Icon section
        const iconSection = this.creatorEl.createEl('div', { cls: 'frontpage-group-creator-section' });
        iconSection.createEl('label', { text: 'Icon:' });

        const iconGrid = iconSection.createEl('div', { cls: 'frontpage-group-creator-icons' });
        const emojis = [
            '📁', '📂', '⭐', '❤️', '💼', '🏠', '🎮', '🎵', '📚', '🔧',
            '💡', '🎯', '🚀', '💻', '📱', '🌐', '🔒', '📧', '📰', '🛒',
            '🎨', '📷', '🎬', '✈️', '🍔', '☕', '🏃', '💪', '🧠', '📊',
            '💰', '🎁', '🔔', '⚡', '🌟', '🔥', '💎', '🏆', '👤', '👥'
        ];

        for (const emoji of emojis) {
            const btn = iconGrid.createEl('button', {
                cls: `frontpage-icon-btn ${emoji === this.newGroupData.icon ? 'is-selected' : ''}`,
                attr: { type: 'button' }
            });
            btn.textContent = emoji;
            btn.addEventListener('click', () => {
                this.newGroupData.icon = emoji;
                iconGrid.querySelectorAll('.frontpage-icon-btn').forEach(b => b.removeClass('is-selected'));
                btn.addClass('is-selected');
            });
        }

        // Custom icon input
        const customIconWrapper = iconSection.createEl('div', { cls: 'frontpage-group-creator-custom-icon' });
        const customInput = customIconWrapper.createEl('input', {
            cls: 'frontpage-modal-input',
            attr: { type: 'text', placeholder: 'Custom', maxlength: '2' }
        });
        customInput.style.width = '50px';
        const useBtn = customIconWrapper.createEl('button', {
            cls: 'frontpage-small-btn',
            attr: { type: 'button' },
            text: 'Use'
        });
        useBtn.addEventListener('click', () => {
            if (customInput.value.trim()) {
                this.newGroupData.icon = customInput.value.trim();
                iconGrid.querySelectorAll('.frontpage-icon-btn').forEach(b => b.removeClass('is-selected'));
            }
        });

        // Color section
        const colorSection = this.creatorEl.createEl('div', { cls: 'frontpage-group-creator-section' });
        colorSection.createEl('label', { text: 'Color:' });

        const colorWrapper = colorSection.createEl('div', { cls: 'frontpage-group-creator-color' });
        const colorInput = colorWrapper.createEl('input', {
            attr: { type: 'color', value: this.newGroupData.color || '#5090d0' }
        });
        colorInput.addEventListener('input', () => {
            this.newGroupData.color = colorInput.value;
        });
        // Initialize with the color input's value if no color was set
        if (!this.newGroupData.color) {
            this.newGroupData.color = colorInput.value;
        }

        // Parent group section
        const parentSection = this.creatorEl.createEl('div', { cls: 'frontpage-group-creator-section' });
        parentSection.createEl('label', { text: 'Parent Group:' });

        const parentSelect = parentSection.createEl('select', { cls: 'frontpage-modal-select' });
        parentSelect.createEl('option', { text: 'None (top-level)', attr: { value: '' } });

        // Add only top-level groups as parent options
        for (const name of this.plugin.settings.groupOrder) {
            const group = this.plugin.settings.groups[name];
            if (group && !group.parentGroup) {
                const icon = group.icon || '📁';
                parentSelect.createEl('option', {
                    text: `${icon} ${name}`,
                    attr: { value: name }
                });
            }
        }

        parentSelect.addEventListener('change', () => {
            this.newGroupData.parentGroup = parentSelect.value || null;
        });
    }

    showDropdown() {
        // Position dropdown using fixed positioning to escape modal overflow
        const rect = this.inputWrapper.getBoundingClientRect();
        this.dropdown.style.position = 'fixed';
        this.dropdown.style.top = `${rect.bottom + 4}px`;
        this.dropdown.style.left = `${rect.left}px`;
        this.dropdown.style.width = `${rect.width}px`;
        this.dropdown.addClass('is-visible');
    }

    hideDropdown() {
        this.dropdown.removeClass('is-visible');
        this.highlightedIndex = -1;
    }

    /**
     * Get the selected group or new group data
     * @returns {Object|null} { name, icon?, color?, parentGroup?, isNew: boolean } or null
     */
    getSelectedGroup() {
        if (this.isCreatingNew && this.newGroupData.name) {
            return {
                name: this.newGroupData.name,
                icon: this.newGroupData.icon,
                color: this.newGroupData.color,
                parentGroup: this.newGroupData.parentGroup,
                isNew: true
            };
        }
        if (this.selectedGroup) {
            return {
                name: this.selectedGroup,
                isNew: false
            };
        }
        return null;
    }

    destroy() {
        this.wrapper.remove();
    }
}

class IconPickerModal extends Modal {
    constructor(app, onSelect) {
        super(app);
        this.onSelect = onSelect;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: 'Choose an Icon' });

        // Common emoji categories
        const emojis = [
            '📁', '📂', '⭐', '❤️', '💼', '🏠', '🎮', '🎵', '📚', '🔧',
            '💡', '🎯', '🚀', '💻', '📱', '🌐', '🔒', '📧', '📰', '🛒',
            '🎨', '📷', '🎬', '✈️', '🍔', '☕', '🏃', '💪', '🧠', '📊',
            '💰', '🎁', '🔔', '⚡', '🌟', '🔥', '💎', '🏆', '👤', '👥'
        ];

        const grid = contentEl.createEl('div', { cls: 'frontpage-icon-grid' });

        for (const emoji of emojis) {
            const btn = grid.createEl('button', {
                cls: 'frontpage-icon-btn',
                text: emoji
            });
            btn.addEventListener('click', () => {
                this.onSelect(emoji);
                this.close();
            });
        }

        // Custom input
        const customContainer = contentEl.createEl('div', { cls: 'frontpage-custom-icon' });
        customContainer.createEl('span', { text: 'Or enter custom: ' });
        const customInput = customContainer.createEl('input', {
            cls: 'frontpage-modal-input',
            attr: { type: 'text', placeholder: 'Any emoji', maxlength: '2' }
        });
        const customBtn = customContainer.createEl('button', { text: 'Use' });
        customBtn.addEventListener('click', () => {
            if (customInput.value) {
                this.onSelect(customInput.value);
                this.close();
            }
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Modal for creating a new group with name, icon, color, and optional parent
 * Replaces GroupNameModal for creation scenarios (not rename)
 */
class CreateGroupModal extends Modal {
    /**
     * @param {App} app
     * @param {FrontpagePlugin} plugin
     * @param {Function} onSubmit - Called with { name, icon, color, parentGroup } on success
     * @param {Object} options - Configuration options
     * @param {string} [options.initialName] - Pre-filled name
     * @param {string} [options.initialIcon] - Pre-selected icon
     * @param {string} [options.initialColor] - Pre-selected color
     * @param {string} [options.initialParent] - Pre-selected parent group
     * @param {string} [options.title] - Modal title
     * @param {string} [options.buttonText] - Submit button text
     */
    constructor(app, plugin, onSubmit, options = {}) {
        super(app);
        this.plugin = plugin;
        this.onSubmit = onSubmit;
        this.options = {
            initialName: '',
            initialIcon: '📁',
            initialColor: '#5090d0',
            initialParent: null,
            title: 'Create Group',
            buttonText: 'Create',
            ...options
        };
        this.selectedIcon = this.options.initialIcon;
        this.selectedColor = this.options.initialColor;
        this.selectedParent = this.options.initialParent;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('frontpage-create-group-modal');
        contentEl.createEl('h3', { text: this.options.title });

        // Name input
        const nameContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        nameContainer.createEl('label', { text: 'Name' });
        const nameInput = nameContainer.createEl('input', {
            cls: 'frontpage-modal-input',
            attr: { type: 'text', placeholder: 'Group name' }
        });
        nameInput.value = this.options.initialName;

        // Icon section
        const iconContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        iconContainer.createEl('label', { text: 'Icon' });

        const iconGrid = iconContainer.createEl('div', { cls: 'frontpage-icon-grid frontpage-icon-grid-inline' });
        const emojis = [
            '📁', '📂', '⭐', '❤️', '💼', '🏠', '🎮', '🎵', '📚', '🔧',
            '💡', '🎯', '🚀', '💻', '📱', '🌐', '🔒', '📧', '📰', '🛒',
            '🎨', '📷', '🎬', '✈️', '🍔', '☕', '🏃', '💪', '🧠', '📊',
            '💰', '🎁', '🔔', '⚡', '🌟', '🔥', '💎', '🏆', '👤', '👥'
        ];

        for (const emoji of emojis) {
            const btn = iconGrid.createEl('button', {
                cls: `frontpage-icon-btn ${emoji === this.selectedIcon ? 'is-selected' : ''}`,
                attr: { type: 'button' }
            });
            btn.textContent = emoji;
            btn.addEventListener('click', () => {
                this.selectedIcon = emoji;
                iconGrid.querySelectorAll('.frontpage-icon-btn').forEach(b => b.removeClass('is-selected'));
                btn.addClass('is-selected');
            });
        }

        // Custom icon input
        const customContainer = iconContainer.createEl('div', { cls: 'frontpage-custom-icon' });
        customContainer.createEl('span', { text: 'Custom: ' });
        const customInput = customContainer.createEl('input', {
            cls: 'frontpage-modal-input',
            attr: { type: 'text', placeholder: 'Any emoji', maxlength: '2' }
        });
        customInput.style.width = '60px';
        const customBtn = customContainer.createEl('button', {
            cls: 'frontpage-small-btn',
            attr: { type: 'button' },
            text: 'Use'
        });
        customBtn.addEventListener('click', () => {
            if (customInput.value.trim()) {
                this.selectedIcon = customInput.value.trim();
                iconGrid.querySelectorAll('.frontpage-icon-btn').forEach(b => b.removeClass('is-selected'));
            }
        });

        // Color section
        const colorContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        colorContainer.createEl('label', { text: 'Color' });

        const colorWrapper = colorContainer.createEl('div', { cls: 'frontpage-color-picker-row' });
        const colorInput = colorWrapper.createEl('input', {
            attr: { type: 'color', value: this.selectedColor }
        });
        const colorPreview = colorWrapper.createEl('span', { cls: 'frontpage-color-preview' });
        colorPreview.style.backgroundColor = this.selectedColor;
        colorPreview.textContent = this.selectedColor;

        colorInput.addEventListener('input', () => {
            this.selectedColor = colorInput.value;
            colorPreview.style.backgroundColor = colorInput.value;
            colorPreview.textContent = colorInput.value;
        });

        // Parent group section
        const parentContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        parentContainer.createEl('label', { text: 'Parent Group (optional)' });

        const parentSelect = parentContainer.createEl('select', { cls: 'frontpage-modal-select' });
        parentSelect.createEl('option', { text: 'None (top-level)', attr: { value: '' } });

        // Add only top-level groups as parent options
        for (const name of this.plugin.settings.groupOrder) {
            const group = this.plugin.settings.groups[name];
            if (group && !group.parentGroup) {
                const icon = group.icon || '📁';
                const option = parentSelect.createEl('option', {
                    text: `${icon} ${name}`,
                    attr: { value: name }
                });
                if (name === this.selectedParent) {
                    option.selected = true;
                }
            }
        }

        parentSelect.addEventListener('change', () => {
            this.selectedParent = parentSelect.value || null;
        });

        // Buttons
        const buttonContainer = contentEl.createEl('div', { cls: 'frontpage-modal-buttons' });

        const submitBtn = buttonContainer.createEl('button', {
            cls: 'mod-cta',
            text: this.options.buttonText
        });
        submitBtn.addEventListener('click', () => {
            const name = nameInput.value.trim();
            if (!name) {
                new Notice('Please enter a group name');
                return;
            }
            if (this.plugin.settings.groups[name]) {
                new Notice('A group with this name already exists');
                return;
            }
            this.onSubmit({
                name,
                icon: this.selectedIcon,
                color: this.selectedColor,
                parentGroup: this.selectedParent
            });
            this.close();
        });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        // Handle Enter key in name input
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitBtn.click();
            }
        });

        // Focus name input
        nameInput.focus();
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Modal for editing an existing group's name, icon, color, and parent
 */
class EditGroupModal extends Modal {
    /**
     * @param {App} app
     * @param {FrontpagePlugin} plugin
     * @param {string} groupName - The name of the group to edit
     * @param {Function} onSave - Called with { name, icon, color, parentGroup } on save
     */
    constructor(app, plugin, groupName, onSave) {
        super(app);
        this.plugin = plugin;
        this.groupName = groupName;
        this.onSave = onSave;

        const group = plugin.settings.groups[groupName];
        this.originalName = groupName;
        this.selectedIcon = group?.icon || '📁';
        this.selectedColor = group?.color || '#5090d0';
        this.selectedParent = group?.parentGroup || null;
        this.hasChildren = plugin.getSubGroups(groupName).length > 0;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('frontpage-create-group-modal');
        contentEl.createEl('h3', { text: 'Edit Group' });

        // Name input
        const nameContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        nameContainer.createEl('label', { text: 'Name' });
        const nameInput = nameContainer.createEl('input', {
            cls: 'frontpage-modal-input',
            attr: { type: 'text', placeholder: 'Group name' }
        });
        nameInput.value = this.groupName;

        // Icon section
        const iconContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        iconContainer.createEl('label', { text: 'Icon' });

        const iconGrid = iconContainer.createEl('div', { cls: 'frontpage-icon-grid frontpage-icon-grid-inline' });
        const emojis = [
            '📁', '📂', '⭐', '❤️', '💼', '🏠', '🎮', '🎵', '📚', '🔧',
            '💡', '🎯', '🚀', '💻', '📱', '🌐', '🔒', '📧', '📰', '🛒',
            '🎨', '📷', '🎬', '✈️', '🍔', '☕', '🏃', '💪', '🧠', '📊',
            '💰', '🎁', '🔔', '⚡', '🌟', '🔥', '💎', '🏆', '👤', '👥'
        ];

        for (const emoji of emojis) {
            const btn = iconGrid.createEl('button', {
                cls: `frontpage-icon-btn ${emoji === this.selectedIcon ? 'is-selected' : ''}`,
                attr: { type: 'button' }
            });
            btn.textContent = emoji;
            btn.addEventListener('click', () => {
                this.selectedIcon = emoji;
                iconGrid.querySelectorAll('.frontpage-icon-btn').forEach(b => b.removeClass('is-selected'));
                btn.addClass('is-selected');
            });
        }

        // Custom icon input
        const customContainer = iconContainer.createEl('div', { cls: 'frontpage-custom-icon' });
        customContainer.createEl('span', { text: 'Custom: ' });
        const customInput = customContainer.createEl('input', {
            cls: 'frontpage-modal-input',
            attr: { type: 'text', placeholder: 'Any emoji', maxlength: '2' }
        });
        customInput.style.width = '60px';
        const customBtn = customContainer.createEl('button', {
            cls: 'frontpage-small-btn',
            attr: { type: 'button' },
            text: 'Use'
        });
        customBtn.addEventListener('click', () => {
            if (customInput.value.trim()) {
                this.selectedIcon = customInput.value.trim();
                iconGrid.querySelectorAll('.frontpage-icon-btn').forEach(b => b.removeClass('is-selected'));
            }
        });

        // Color section
        const colorContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        colorContainer.createEl('label', { text: 'Color' });

        const colorWrapper = colorContainer.createEl('div', { cls: 'frontpage-color-picker-row' });
        const colorInput = colorWrapper.createEl('input', {
            attr: { type: 'color', value: this.selectedColor || '#5090d0' }
        });
        const colorPreview = colorWrapper.createEl('span', { cls: 'frontpage-color-preview' });
        colorPreview.style.backgroundColor = this.selectedColor || '#5090d0';
        colorPreview.textContent = this.selectedColor || '#5090d0';

        colorInput.addEventListener('input', () => {
            this.selectedColor = colorInput.value;
            colorPreview.style.backgroundColor = colorInput.value;
            colorPreview.textContent = colorInput.value;
        });

        // Parent group section (only show if this group doesn't have children)
        if (!this.hasChildren) {
            const parentContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
            parentContainer.createEl('label', { text: 'Parent Group' });

            const parentSelect = parentContainer.createEl('select', { cls: 'frontpage-modal-select' });
            parentSelect.createEl('option', { text: 'None (top-level)', attr: { value: '' } });

            // Add only top-level groups as parent options (excluding self)
            for (const name of this.plugin.settings.groupOrder) {
                if (name === this.groupName) continue; // Can't be own parent
                const group = this.plugin.settings.groups[name];
                if (group && !group.parentGroup) {
                    const icon = group.icon || '📁';
                    const option = parentSelect.createEl('option', {
                        text: `${icon} ${name}`,
                        attr: { value: name }
                    });
                    if (name === this.selectedParent) {
                        option.selected = true;
                    }
                }
            }

            parentSelect.addEventListener('change', () => {
                this.selectedParent = parentSelect.value || null;
            });
        } else {
            // Show info that parent can't be changed because group has children
            const infoContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
            infoContainer.createEl('label', { text: 'Parent Group' });
            const infoText = infoContainer.createEl('div', {
                cls: 'frontpage-edit-group-info',
                text: 'This group has sub-groups and cannot be moved under another group.'
            });
            infoText.style.color = 'var(--text-muted)';
            infoText.style.fontSize = '12px';
            infoText.style.fontStyle = 'italic';
        }

        // Buttons
        const buttonContainer = contentEl.createEl('div', { cls: 'frontpage-modal-buttons' });

        const saveBtn = buttonContainer.createEl('button', {
            cls: 'mod-cta',
            text: 'Save'
        });
        saveBtn.addEventListener('click', async () => {
            const newName = nameInput.value.trim();
            if (!newName) {
                new Notice('Please enter a group name');
                return;
            }
            // Check if renaming to an existing group name
            if (newName !== this.originalName && this.plugin.settings.groups[newName]) {
                new Notice('A group with this name already exists');
                return;
            }

            this.onSave({
                originalName: this.originalName,
                name: newName,
                icon: this.selectedIcon,
                color: this.selectedColor,
                parentGroup: this.hasChildren ? this.selectedParent : this.selectedParent
            });
            this.close();
        });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        // Handle Enter key in name input
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                saveBtn.click();
            }
        });

        // Focus name input
        nameInput.focus();
        nameInput.select();
    }

    onClose() {
        this.contentEl.empty();
    }
}

class ImportBookmarksModal extends Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('frontpage-import-modal');
        contentEl.createEl('h3', { text: 'Import Bookmarks' });

        contentEl.createEl('p', { text: 'Import bookmarks from a browser export (HTML file).' });

        const fileInput = contentEl.createEl('input', {
            attr: { type: 'file', accept: '.html,.htm' }
        });

        const statusEl = contentEl.createEl('div', { cls: 'frontpage-import-status' });

        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            statusEl.textContent = 'Reading file...';

            try {
                const text = await file.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(text, 'text/html');
                const links = doc.querySelectorAll('a[href^="http"]');

                if (links.length === 0) {
                    statusEl.textContent = 'No bookmarks found in file.';
                    return;
                }

                const MAX_BROWSER_IMPORT = 10000;
                if (links.length > MAX_BROWSER_IMPORT) {
                    new Notice(`Too many bookmarks (${links.length}). Maximum is ${MAX_BROWSER_IMPORT}.`);
                    statusEl.textContent = `Too many bookmarks (${links.length}). Maximum is ${MAX_BROWSER_IMPORT}.`;
                    return;
                }

                statusEl.textContent = `Found ${links.length} bookmarks. Importing...`;

                const isValidHttpUrl = (url) => {
                    return url && (url.startsWith('http://') || url.startsWith('https://'));
                };

                let imported = 0;
                let skipped = 0;
                let invalidUrls = 0;

                for (const link of links) {
                    const url = link.getAttribute('href');

                    if (!isValidHttpUrl(url)) {
                        invalidUrls++;
                        continue;
                    }

                    const title = link.textContent?.trim() || url;

                    const added = await this.plugin.addBookmark({ title, url });
                    if (added) {
                        imported++;
                    } else {
                        skipped++;
                    }
                }

                let statusParts = [`Imported ${imported} bookmarks`];
                if (skipped > 0) statusParts.push(`${skipped} duplicates skipped`);
                if (invalidUrls > 0) statusParts.push(`${invalidUrls} invalid URLs skipped`);
                statusEl.textContent = statusParts.length > 1 ? `${statusParts[0]} (${statusParts.slice(1).join(', ')}).` : `${statusParts[0]}.`;
                new Notice(`Imported ${imported} bookmarks`);

            } catch (error) {
                console.error('Import error:', error);
                statusEl.textContent = 'Error reading file.';
            }
        });

        const buttonContainer = contentEl.createEl('div', { cls: 'frontpage-modal-buttons' });
        const closeBtn = buttonContainer.createEl('button', { text: 'Close' });
        closeBtn.addEventListener('click', () => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }
}

class DuplicatesModal extends Modal {
    constructor(app, plugin, duplicates) {
        super(app);
        this.plugin = plugin;
        this.duplicates = duplicates;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('frontpage-duplicates-modal');
        contentEl.createEl('h3', { text: 'Duplicate Bookmarks' });

        if (this.duplicates.length === 0) {
            contentEl.createEl('p', { text: 'No duplicate bookmarks found!' });
        } else {
            contentEl.createEl('p', {
                text: `Found ${this.duplicates.length} URL${this.duplicates.length !== 1 ? 's' : ''} with duplicates.`
            });

            const list = contentEl.createEl('div', { cls: 'frontpage-duplicates-list' });

            for (const group of this.duplicates) {
                const groupEl = list.createEl('div', { cls: 'frontpage-duplicate-group' });
                groupEl.createEl('div', { cls: 'frontpage-duplicate-url', text: group.url });

                for (const bookmark of group.bookmarks) {
                    const itemEl = groupEl.createEl('div', { cls: 'frontpage-duplicate-item' });
                    itemEl.createEl('span', { text: bookmark.title });

                    const deleteBtn = itemEl.createEl('button', {
                        cls: 'frontpage-duplicate-delete',
                        text: 'Delete'
                    });
                    deleteBtn.addEventListener('click', async () => {
                        new ConfirmModal(
                            this.app,
                            'Delete Permanently',
                            `Permanently delete "${bookmark.title}"? This cannot be undone.`,
                            async () => {
                                await this.plugin.deleteBookmark(bookmark.url);
                                itemEl.remove();
                                new Notice('Deleted duplicate');
                            },
                            'Delete',
                            'Cancel',
                            true
                        ).open();
                    });
                }
            }
        }

        const buttonContainer = contentEl.createEl('div', { cls: 'frontpage-modal-buttons' });
        const closeBtn = buttonContainer.createEl('button', { text: 'Close' });
        closeBtn.addEventListener('click', () => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }
}

class BrokenLinksModal extends Modal {
    constructor(app, plugin, brokenLinks) {
        super(app);
        this.plugin = plugin;
        this.brokenLinks = brokenLinks;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('frontpage-broken-links-modal');
        contentEl.createEl('h3', { text: 'Broken Links' });

        if (this.brokenLinks.length === 0) {
            contentEl.createEl('p', { text: 'No broken links found! All bookmarks are working.' });
        } else {
            contentEl.createEl('p', {
                text: `Found ${this.brokenLinks.length} potentially broken link${this.brokenLinks.length !== 1 ? 's' : ''}.`
            });
            contentEl.createEl('p', {
                cls: 'frontpage-broken-links-note',
                text: 'Note: Some links may appear broken due to CORS restrictions. Click "Mark as Good" if a link works in your browser.'
            });

            const list = contentEl.createEl('div', { cls: 'frontpage-broken-links-list' });

            for (const link of this.brokenLinks) {
                const itemEl = list.createEl('div', { cls: 'frontpage-broken-link-item' });

                const infoEl = itemEl.createEl('div', { cls: 'frontpage-broken-link-info' });
                const titleLink = infoEl.createEl('a', {
                    cls: 'frontpage-broken-link-title',
                    text: link.title,
                    attr: { href: link.url, target: '_blank', rel: 'noopener noreferrer' }
                });
                infoEl.createEl('div', { cls: 'frontpage-broken-link-error', text: link.error });

                const actionsEl = itemEl.createEl('div', { cls: 'frontpage-broken-link-actions' });

                const markGoodBtn = actionsEl.createEl('button', { text: 'Mark as Good' });
                markGoodBtn.addEventListener('click', async () => {
                    if (!this.plugin.settings.ignoredBrokenLinks) {
                        this.plugin.settings.ignoredBrokenLinks = [];
                    }
                    this.plugin.settings.ignoredBrokenLinks.push(link.url);
                    await this.plugin.saveSettings();
                    itemEl.remove();
                    new Notice('Marked as good');
                });

                const deleteBtn = actionsEl.createEl('button', {
                    cls: 'mod-warning',
                    text: 'Delete'
                });
                deleteBtn.addEventListener('click', async () => {
                    new ConfirmModal(
                        this.app,
                        'Delete Permanently',
                        `Permanently delete "${link.title}"? This cannot be undone.`,
                        async () => {
                            await this.plugin.deleteBookmark(link.url);
                            itemEl.remove();
                            new Notice('Deleted bookmark');
                        },
                        'Delete',
                        'Cancel',
                        true
                    ).open();
                });
            }
        }

        const buttonContainer = contentEl.createEl('div', { cls: 'frontpage-modal-buttons' });
        const closeBtn = buttonContainer.createEl('button', { text: 'Close' });
        closeBtn.addEventListener('click', () => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }
}

class QuickAddBookmarkModal extends Modal {
    /**
     * @param {App} app
     * @param {FrontpagePlugin} plugin
     * @param {Object} [prefill] - Optional pre-filled data from Smart Paste
     * @param {string} [prefill.url]
     * @param {string} [prefill.title]
     * @param {string} [prefill.description]
     * @param {string} [prefill.tags]
     * @param {string} [prefill.group]
     */
    constructor(app, plugin, prefill = null) {
        super(app);
        this.plugin = plugin;
        this.prefill = prefill;
    }

    onOpen() {
        const { contentEl } = this;
        const prefill = this.prefill || {};

        contentEl.addClass('frontpage-quick-add-modal');
        contentEl.createEl('h3', { text: prefill.url ? 'Add Bookmark (Smart Paste)' : 'Add Bookmark' });

        // URL input
        const urlContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        urlContainer.createEl('label', { text: 'URL' });
        const urlInput = urlContainer.createEl('input', {
            cls: 'frontpage-modal-input',
            attr: { type: 'url', placeholder: 'https://example.com' }
        });
        if (prefill.url) urlInput.value = prefill.url;

        // Title input
        const titleContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        titleContainer.createEl('label', { text: 'Title' });
        const titleInput = titleContainer.createEl('input', {
            cls: 'frontpage-modal-input',
            attr: { type: 'text', placeholder: 'Bookmark title' }
        });
        if (prefill.title) titleInput.value = prefill.title;

        // Description input
        const descContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        descContainer.createEl('label', { text: 'Description (optional)' });
        const descInput = descContainer.createEl('input', {
            cls: 'frontpage-modal-input',
            attr: { type: 'text', placeholder: 'Brief description' }
        });
        if (prefill.description) descInput.value = prefill.description;

        // Tags input with autocomplete
        const tagsContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        tagsContainer.createEl('label', { text: 'Tags (optional)' });
        const prefillTags = prefill.tags
            ? prefill.tags.split(',').map(t => t.trim()).filter(t => t)
            : [];
        const tagInput = new TagAutocompleteInput(tagsContainer, this.plugin, prefillTags);

        // Group selection with inline creation
        const groupContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        groupContainer.createEl('label', { text: 'Add to Group (optional)' });
        const groupInput = new GroupComboboxInput(groupContainer, this.plugin, {
            placeholder: 'Select or create group...',
            initialValue: prefill.group || null
        });

        // Add to favorites checkbox
        const favContainer = contentEl.createEl('div', { cls: 'frontpage-modal-checkbox' });
        const favCheckbox = favContainer.createEl('input', {
            attr: { type: 'checkbox', id: 'add-to-favorites' }
        });
        favContainer.createEl('label', { text: 'Add to Favorites', attr: { for: 'add-to-favorites' } });

        const buttonContainer = contentEl.createEl('div', { cls: 'frontpage-modal-buttons' });

        const addBtn = buttonContainer.createEl('button', { cls: 'mod-cta', text: 'Add Bookmark' });
        addBtn.addEventListener('click', async () => {
            const url = urlInput.value.trim();
            const title = titleInput.value.trim() || url;
            const description = descInput.value.trim();
            const tags = tagInput.getTags();
            const groupResult = groupInput.getSelectedGroup();
            const addToFavorites = favCheckbox.checked;

            if (!url) {
                new Notice('Please enter a URL');
                return;
            }

            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                new Notice('URL must start with http:// or https://');
                return;
            }

            const added = await this.plugin.addBookmark({ title, url, description, tags });

            if (added) {
                if (groupResult) {
                    // Create new group if needed
                    if (groupResult.isNew) {
                        await this.plugin.createGroup(groupResult.name, {
                            icon: groupResult.icon,
                            color: groupResult.color,
                            parentGroup: groupResult.parentGroup
                        });
                    }
                    await this.plugin.addToGroup(url, groupResult.name);
                }
                if (addToFavorites) {
                    await this.plugin.addToFavorites(url);
                }
                new Notice('Bookmark added!');
                this.close();
            } else {
                new Notice('A bookmark with this URL already exists');
            }
        });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        // Focus appropriate field: title if URL is prefilled, otherwise URL
        if (prefill.url && !prefill.title) {
            titleInput.focus();
        } else {
            urlInput.focus();
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

class TagFilterModal extends Modal {
    constructor(app, plugin, view) {
        super(app);
        this.plugin = plugin;
        this.view = view;
        this.selectedTags = new Set(view.activeTagFilters);
        this.filterMode = plugin.settings.tagFilterMode || 'AND';
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('frontpage-tag-filter-modal');

        // Fixed header with title, mode, preview and actions
        const headerSection = contentEl.createEl('div', { cls: 'frontpage-filter-header' });
        headerSection.createEl('h3', { text: 'Filter by Tags' });

        // Mode toggle
        const modeContainer = headerSection.createEl('div', { cls: 'frontpage-filter-mode-container' });
        modeContainer.createEl('span', { text: 'Match: ' });

        const modeSelect = modeContainer.createEl('select', { cls: 'frontpage-filter-mode-select' });
        const andOption = modeSelect.createEl('option', { text: 'ALL tags (AND)', attr: { value: 'AND' } });
        const orOption = modeSelect.createEl('option', { text: 'ANY tag (OR)', attr: { value: 'OR' } });
        if (this.filterMode === 'OR') orOption.selected = true;
        else andOption.selected = true;

        modeSelect.addEventListener('change', () => {
            this.filterMode = modeSelect.value;
            this.updatePreview();
        });

        // Preview (in header so always visible)
        const previewContainer = headerSection.createEl('div', { cls: 'frontpage-filter-preview' });
        this.previewEl = previewContainer;

        // Buttons (in header so always visible)
        const buttonContainer = headerSection.createEl('div', { cls: 'frontpage-modal-buttons' });

        this.saveCollectionBtn = buttonContainer.createEl('button', {
            text: 'Save as Collection',
            cls: 'frontpage-save-collection-btn'
        });
        this.saveCollectionBtn.style.display = this.selectedTags.size > 0 ? '' : 'none';
        this.saveCollectionBtn.addEventListener('click', () => {
            this.close();
            new SaveCollectionModal(this.app, this.plugin, Array.from(this.selectedTags)).open();
        });

        const clearBtn = buttonContainer.createEl('button', { text: 'Clear All' });
        clearBtn.addEventListener('click', () => {
            this.selectedTags.clear();
            contentEl.querySelectorAll('.frontpage-filter-tag').forEach(el => el.removeClass('is-selected'));
            this.updatePreview();
        });

        const applyBtn = buttonContainer.createEl('button', { cls: 'mod-cta', text: 'Apply Filter' });
        applyBtn.addEventListener('click', async () => {
            this.view.activeTagFilters = new Set(this.selectedTags);
            this.plugin.settings.tagFilterMode = this.filterMode;
            await this.plugin.saveSettings(false);
            this.close();
            this.view.render();
        });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        // Collapsible tags section
        const allTags = this.plugin.getAllTags();
        const tagsSection = contentEl.createEl('div', { cls: 'frontpage-filter-tags-section' });

        // Collapsible header
        const tagsSectionHeader = tagsSection.createEl('div', { cls: 'frontpage-filter-tags-header' });
        const collapseIcon = tagsSectionHeader.createEl('span', { cls: 'frontpage-filter-collapse-icon', text: '▼' });
        tagsSectionHeader.createEl('span', { text: `Available Tags (${allTags.size})` });

        const tagsContainer = tagsSection.createEl('div', { cls: 'frontpage-filter-tags-container' });

        // Toggle collapse
        let isCollapsed = false;
        tagsSectionHeader.addEventListener('click', () => {
            isCollapsed = !isCollapsed;
            tagsContainer.style.display = isCollapsed ? 'none' : '';
            collapseIcon.textContent = isCollapsed ? '▶' : '▼';
            tagsSection.toggleClass('is-collapsed', isCollapsed);
        });

        if (allTags.size === 0) {
            tagsContainer.createEl('p', { cls: 'frontpage-no-tags', text: 'No tags found in your bookmarks.' });
        } else {
            const sortedTags = Array.from(allTags.entries()).sort((a, b) => a[0].localeCompare(b[0]));

            for (const [tag, count] of sortedTags) {
                const isSelected = this.selectedTags.has(tag);
                const tagEl = tagsContainer.createEl('button', {
                    cls: `frontpage-filter-tag ${isSelected ? 'is-selected' : ''}`,
                    attr: { 'data-tag': tag }
                });
                tagEl.createEl('span', { cls: 'frontpage-filter-tag-name', text: tag });
                tagEl.createEl('span', { cls: 'frontpage-filter-tag-count', text: `${count}` });

                tagEl.addEventListener('click', () => {
                    if (this.selectedTags.has(tag)) {
                        this.selectedTags.delete(tag);
                        tagEl.removeClass('is-selected');
                    } else {
                        this.selectedTags.add(tag);
                        tagEl.addClass('is-selected');
                    }
                    this.updatePreview();
                });
            }
        }

        this.updatePreview();
    }

    updatePreview() {
        if (!this.previewEl) return;
        this.previewEl.empty();

        // Toggle Save Collection button visibility
        if (this.saveCollectionBtn) {
            this.saveCollectionBtn.style.display = this.selectedTags.size > 0 ? '' : 'none';
        }

        if (this.selectedTags.size === 0) {
            this.previewEl.createEl('span', { cls: 'frontpage-filter-preview-text', text: 'No tags selected - showing all bookmarks' });
            return;
        }

        const matchingBookmarks = this.plugin.getBookmarksByTags(Array.from(this.selectedTags), this.filterMode);
        this.previewEl.createEl('span', {
            cls: 'frontpage-filter-preview-text',
            text: `${matchingBookmarks.length} bookmark${matchingBookmarks.length !== 1 ? 's' : ''} match`
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

class TagManagementModal extends Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('frontpage-tag-management-modal');
        contentEl.createEl('h3', { text: 'Manage Tags' });

        const allTags = this.plugin.getAllTags();

        if (allTags.size === 0) {
            contentEl.createEl('p', { text: 'No tags found in your bookmarks.' });
            return;
        }

        // Merge tags section
        const mergeSection = contentEl.createEl('div', { cls: 'frontpage-tag-mgmt-section' });
        mergeSection.createEl('h4', { text: 'Merge Tags' });
        mergeSection.createEl('p', {
            cls: 'frontpage-tag-mgmt-desc',
            text: 'Combine two tags into one across all bookmarks.'
        });

        const mergeContainer = mergeSection.createEl('div', { cls: 'frontpage-merge-container' });

        const fromSelect = mergeContainer.createEl('select', { cls: 'frontpage-modal-select' });
        fromSelect.createEl('option', { text: 'Select tag to replace...', attr: { value: '' } });
        for (const [tag, count] of allTags) {
            fromSelect.createEl('option', { text: `${tag} (${count})`, attr: { value: tag } });
        }

        mergeContainer.createEl('span', { text: ' → ' });

        const toSelect = mergeContainer.createEl('select', { cls: 'frontpage-modal-select' });
        toSelect.createEl('option', { text: 'Select target tag...', attr: { value: '' } });
        for (const [tag, count] of allTags) {
            toSelect.createEl('option', { text: `${tag} (${count})`, attr: { value: tag } });
        }

        const mergeBtn = mergeContainer.createEl('button', { text: 'Merge' });
        mergeBtn.addEventListener('click', async () => {
            const fromTag = fromSelect.value;
            const toTag = toSelect.value;
            if (!fromTag || !toTag) {
                new Notice('Please select both tags');
                return;
            }
            if (fromTag === toTag) {
                new Notice('Please select different tags');
                return;
            }
            const updated = await this.plugin.mergeTag(fromTag, toTag);
            if (updated) {
                new Notice(`Merged "${fromTag}" into "${toTag}"`);
                this.close();
            }
        });

        // Delete tags section
        const deleteSection = contentEl.createEl('div', { cls: 'frontpage-tag-mgmt-section' });
        deleteSection.createEl('h4', { text: 'Delete Tag' });
        deleteSection.createEl('p', {
            cls: 'frontpage-tag-mgmt-desc',
            text: 'Remove a tag from all bookmarks.'
        });

        const deleteContainer = deleteSection.createEl('div', { cls: 'frontpage-delete-container' });

        const deleteSelect = deleteContainer.createEl('select', { cls: 'frontpage-modal-select' });
        deleteSelect.createEl('option', { text: 'Select tag to delete...', attr: { value: '' } });
        for (const [tag, count] of allTags) {
            deleteSelect.createEl('option', { text: `${tag} (${count})`, attr: { value: tag } });
        }

        const deleteBtn = deleteContainer.createEl('button', { cls: 'mod-warning', text: 'Delete' });
        deleteBtn.addEventListener('click', async () => {
            const tag = deleteSelect.value;
            if (!tag) {
                new Notice('Please select a tag');
                return;
            }
            const updated = await this.plugin.deleteTag(tag);
            if (updated) {
                new Notice(`Deleted tag "${tag}"`);
                this.close();
            }
        });

        // Close button
        const buttonContainer = contentEl.createEl('div', { cls: 'frontpage-modal-buttons' });
        const closeBtn = buttonContainer.createEl('button', { text: 'Close' });
        closeBtn.addEventListener('click', () => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }
}

class RenameCollectionModal extends Modal {
    constructor(app, plugin, oldName) {
        super(app);
        this.plugin = plugin;
        this.oldName = oldName;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('frontpage-rename-collection-modal');
        contentEl.createEl('h3', { text: 'Rename Collection' });

        const nameContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        nameContainer.createEl('label', { text: 'New Name' });
        const nameInput = nameContainer.createEl('input', {
            cls: 'frontpage-modal-input',
            attr: { type: 'text' }
        });
        nameInput.value = this.oldName;

        const buttonContainer = contentEl.createEl('div', { cls: 'frontpage-modal-buttons' });

        const saveBtn = buttonContainer.createEl('button', { cls: 'mod-cta', text: 'Rename' });
        saveBtn.addEventListener('click', async () => {
            const newName = nameInput.value.trim();
            if (!newName) {
                new Notice('Please enter a name');
                return;
            }
            if (newName === this.oldName) {
                this.close();
                return;
            }
            if (this.plugin.settings.tagCollections[newName]) {
                new Notice('A collection with this name already exists');
                return;
            }
            await this.plugin.renameCollection(this.oldName, newName);
            new Notice(`Collection renamed to "${newName}"`);
            this.close();
        });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        nameInput.focus();
        nameInput.select();
    }

    onClose() {
        this.contentEl.empty();
    }
}

class SaveCollectionModal extends Modal {
    constructor(app, plugin, tags = []) {
        super(app);
        this.plugin = plugin;
        this.tags = tags;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('frontpage-save-collection-modal');
        contentEl.createEl('h3', { text: 'Save as Collection' });

        // Collection name input
        const nameContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        nameContainer.createEl('label', { text: 'Collection Name' });
        const nameInput = nameContainer.createEl('input', {
            cls: 'frontpage-modal-input',
            attr: { type: 'text', placeholder: 'My Collection' }
        });

        // Show tags that will be saved
        const tagsContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        tagsContainer.createEl('label', { text: 'Tags in Collection' });
        const tagsList = tagsContainer.createEl('div', { cls: 'frontpage-collection-tags-preview' });
        for (const tag of this.tags) {
            tagsList.createEl('span', { cls: 'frontpage-tag', text: tag });
        }

        // Preview count
        const matchingBookmarks = this.plugin.getBookmarksByTags(this.tags, this.plugin.settings.tagFilterMode);
        tagsContainer.createEl('div', {
            cls: 'frontpage-collection-preview-count',
            text: `${matchingBookmarks.length} bookmark${matchingBookmarks.length !== 1 ? 's' : ''} match`
        });

        const buttonContainer = contentEl.createEl('div', { cls: 'frontpage-modal-buttons' });

        const saveBtn = buttonContainer.createEl('button', { cls: 'mod-cta', text: 'Save Collection' });
        saveBtn.addEventListener('click', async () => {
            const name = nameInput.value.trim();
            if (!name) {
                new Notice('Please enter a collection name');
                return;
            }
            if (this.plugin.settings.tagCollections[name]) {
                new Notice('A collection with this name already exists');
                return;
            }
            await this.plugin.saveCollection(name, this.tags);
            new Notice(`Collection "${name}" saved!`);
            this.close();
        });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        nameInput.focus();
    }

    onClose() {
        this.contentEl.empty();
    }
}

class SavePresetModal extends Modal {
    constructor(app, plugin, onSave) {
        super(app);
        this.plugin = plugin;
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('frontpage-save-preset-modal');
        contentEl.createEl('h3', { text: 'Save Current Settings as Preset' });

        const field = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        field.createEl('label', { text: 'Preset Name' });
        const input = field.createEl('input', {
            cls: 'frontpage-modal-input',
            attr: { type: 'text', placeholder: 'My Custom Preset' }
        });

        // Show what will be saved
        const infoContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        infoContainer.createEl('p', {
            cls: 'setting-item-description',
            text: 'This will save your current layout and display settings for all view modes (grid, list, compact).'
        });

        const buttonContainer = contentEl.createEl('div', { cls: 'frontpage-modal-buttons' });

        const saveBtn = buttonContainer.createEl('button', { cls: 'mod-cta', text: 'Save Preset' });
        saveBtn.addEventListener('click', () => {
            const name = input.value.trim();
            if (!name) {
                new Notice('Please enter a preset name');
                return;
            }
            if (BUILT_IN_PRESETS[name]) {
                new Notice('Cannot use a built-in preset name');
                return;
            }
            if (this.plugin.settings.presets && this.plugin.settings.presets[name]) {
                new Notice('A preset with this name already exists');
                return;
            }
            this.onSave(name);
            this.close();
        });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        input.focus();
    }

    onClose() {
        this.contentEl.empty();
    }
}

class InsightsModal extends Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.activeTab = 'mostUsed';
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('frontpage-insights-modal');
        contentEl.createEl('h3', { text: 'Bookmark Insights' });

        // Stats grid
        const stats = this.plugin.getAnalyticsSummary();
        const statsGrid = contentEl.createEl('div', { cls: 'frontpage-insights-stats' });

        this.createStatCard(statsGrid, 'Total Clicks', stats.totalClicks.toString());
        this.createStatCard(statsGrid, 'Active Bookmarks', stats.activeBookmarks.toString());
        this.createStatCard(statsGrid, 'Never Clicked', stats.neverClicked.toString());
        this.createStatCard(statsGrid, `Dormant (${stats.dormantDays}d)`, stats.dormantCount.toString());

        // Tabs
        const tabsContainer = contentEl.createEl('div', { cls: 'frontpage-insights-tabs' });

        const mostUsedTab = tabsContainer.createEl('button', {
            cls: 'frontpage-insights-tab is-active',
            text: 'Most Used'
        });
        const dormantTab = tabsContainer.createEl('button', {
            cls: 'frontpage-insights-tab',
            text: 'Dormant'
        });

        // List container (stored as instance property for re-rendering after actions)
        this.listContainer = contentEl.createEl('div', { cls: 'frontpage-insights-list' });

        // Tab click handlers
        mostUsedTab.addEventListener('click', () => {
            mostUsedTab.addClass('is-active');
            dormantTab.removeClass('is-active');
            this.activeTab = 'mostUsed';
            this.renderList(this.listContainer);
        });

        dormantTab.addEventListener('click', () => {
            dormantTab.addClass('is-active');
            mostUsedTab.removeClass('is-active');
            this.activeTab = 'dormant';
            this.renderList(this.listContainer);
        });

        // Initial render
        this.renderList(this.listContainer);

        // Actions
        const actionsContainer = contentEl.createEl('div', { cls: 'frontpage-insights-actions' });

        // Cleanup Assistant button
        const cleanupBtn = actionsContainer.createEl('button', {
            cls: 'frontpage-insights-cleanup-btn',
            text: '🧹 Cleanup Assistant'
        });
        cleanupBtn.addEventListener('click', () => {
            this.close();
            new CleanupAssistantModal(this.app, this.plugin).open();
        });

        const resetBtn = actionsContainer.createEl('button', {
            cls: 'frontpage-insights-reset-btn',
            text: 'Reset Analytics'
        });
        resetBtn.addEventListener('click', async () => {
            const confirmed = await new Promise(resolve => {
                new ConfirmModal(
                    this.app,
                    'Reset All Analytics',
                    'This will clear all click counts and access times. This cannot be undone.',
                    () => resolve(true),
                    'Reset',
                    'Cancel',
                    true
                ).open();
            });
            if (confirmed) {
                await this.plugin.resetAnalytics();
                new Notice('Analytics data reset');
                this.close();
            }
        });

        const closeBtn = actionsContainer.createEl('button', {
            cls: 'mod-cta',
            text: 'Close'
        });
        closeBtn.addEventListener('click', () => this.close());
    }

    createStatCard(container, label, value) {
        const card = container.createEl('div', { cls: 'frontpage-insights-stat-card' });
        card.createEl('div', { cls: 'frontpage-insights-stat-value', text: value });
        card.createEl('div', { cls: 'frontpage-insights-stat-label', text: label });
    }

    renderList(container) {
        container.empty();

        if (this.activeTab === 'mostUsed') {
            const bookmarks = this.plugin.getMostUsedBookmarks(this.plugin.settings.mostUsedCount || 10);

            if (bookmarks.length === 0) {
                container.createEl('div', {
                    cls: 'frontpage-insights-empty',
                    text: 'No bookmarks have been clicked yet'
                });
                return;
            }

            for (const bookmark of bookmarks) {
                const item = container.createEl('div', { cls: 'frontpage-insights-item' });

                const info = item.createEl('div', { cls: 'frontpage-insights-item-info' });
                info.createEl('div', { cls: 'frontpage-insights-item-title', text: bookmark.title });
                info.createEl('div', { cls: 'frontpage-insights-item-url', text: this.truncateUrl(bookmark.url) });

                item.createEl('div', {
                    cls: 'frontpage-insights-item-count',
                    text: `${bookmark.clickCount} clicks`
                });

                // Action buttons
                this.createActionButtons(item, bookmark);
            }
        } else {
            const dormantDays = this.plugin.settings.dormantDaysThreshold || 30;
            const bookmarks = this.plugin.getDormantBookmarks(dormantDays);

            if (bookmarks.length === 0) {
                container.createEl('div', {
                    cls: 'frontpage-insights-empty',
                    text: 'No dormant bookmarks found'
                });
                return;
            }

            for (const bookmark of bookmarks) {
                const item = container.createEl('div', { cls: 'frontpage-insights-item' });

                const info = item.createEl('div', { cls: 'frontpage-insights-item-info' });
                info.createEl('div', { cls: 'frontpage-insights-item-title', text: bookmark.title });
                info.createEl('div', { cls: 'frontpage-insights-item-url', text: this.truncateUrl(bookmark.url) });

                const lastAccessed = bookmark.lastAccessedAt
                    ? this.formatTimeAgo(bookmark.lastAccessedAt)
                    : 'Never';
                item.createEl('div', {
                    cls: 'frontpage-insights-item-time',
                    text: lastAccessed
                });

                // Action buttons
                this.createActionButtons(item, bookmark);
            }
        }
    }

    truncateUrl(url) {
        try {
            const urlObj = new URL(url);
            return urlObj.hostname + (urlObj.pathname.length > 20 ? urlObj.pathname.slice(0, 20) + '...' : urlObj.pathname);
        } catch {
            return url.slice(0, 40) + (url.length > 40 ? '...' : '');
        }
    }

    formatTimeAgo(timestamp) {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        if (seconds < 60) return 'Just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 30) return `${days}d ago`;
        const months = Math.floor(days / 30);
        return `${months}mo ago`;
    }

    createActionButtons(itemEl, bookmark) {
        const actionsEl = itemEl.createEl('div', { cls: 'frontpage-insights-item-actions' });

        // Open button
        const openBtn = actionsEl.createEl('button', {
            cls: 'frontpage-insights-action-btn',
            attr: { 'aria-label': 'Open bookmark', title: 'Open' }
        });
        openBtn.textContent = '↗';
        openBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.open(bookmark.url, '_blank', 'noopener,noreferrer');
        });

        // Edit button
        const editBtn = actionsEl.createEl('button', {
            cls: 'frontpage-insights-action-btn',
            attr: { 'aria-label': 'Edit bookmark', title: 'Edit' }
        });
        editBtn.textContent = '✏️';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            new EditBookmarkModal(this.app, this.plugin, bookmark).open();
        });

        // Favorite toggle button
        const isFavorite = this.plugin.isFavorite(bookmark.url);
        const favBtn = actionsEl.createEl('button', {
            cls: 'frontpage-insights-action-btn' + (isFavorite ? ' is-favorite' : ''),
            attr: { 'aria-label': isFavorite ? 'Remove from favorites' : 'Add to favorites', title: isFavorite ? 'Unfavorite' : 'Favorite' }
        });
        favBtn.textContent = isFavorite ? '★' : '☆';
        favBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (isFavorite) {
                await this.plugin.removeFromFavorites(bookmark.url);
                new Notice('Removed from Favorites');
            } else {
                await this.plugin.addToFavorites(bookmark.url);
                new Notice('Added to Favorites');
            }
            this.renderList(this.listContainer);
        });

        // Group menu button
        const groupBtn = actionsEl.createEl('button', {
            cls: 'frontpage-insights-action-btn',
            attr: { 'aria-label': 'Add to group', title: 'Add to Group' }
        });
        groupBtn.textContent = '📁';
        groupBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showGroupMenu(e, bookmark);
        });

        // Delete button
        const deleteBtn = actionsEl.createEl('button', {
            cls: 'frontpage-insights-action-btn frontpage-insights-action-delete',
            attr: { 'aria-label': 'Delete bookmark', title: 'Delete' }
        });
        deleteBtn.textContent = '🗑️';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            new ConfirmModal(
                this.app,
                'Delete Bookmark',
                `Delete "${bookmark.title}"? This will remove it from all groups and favorites.`,
                async () => {
                    await this.plugin.deleteBookmark(bookmark.url);
                    new Notice('Bookmark deleted');
                    this.renderList(this.listContainer);
                }
            ).open();
        });
    }

    showGroupMenu(event, bookmark) {
        const menu = new Menu();
        const settings = this.plugin.settings;
        const groupNames = settings.groupOrder || [];

        if (groupNames.length === 0) {
            menu.addItem((item) => {
                item.setTitle('No groups created')
                    .setDisabled(true);
            });
        } else {
            for (const name of groupNames) {
                const normalizedUrl = this.plugin.normalizeUrl(bookmark.url);
                const isInGroup = settings.groups[name]?.urls?.includes(normalizedUrl);
                menu.addItem((item) => {
                    item.setTitle(isInGroup ? `✓ ${name}` : name)
                        .onClick(async () => {
                            if (isInGroup) {
                                await this.plugin.removeFromGroup(bookmark.url, name);
                                new Notice(`Removed from "${name}"`);
                            } else {
                                await this.plugin.addToGroup(bookmark.url, name);
                                new Notice(`Added to "${name}"`);
                            }
                        });
                });
            }
        }

        menu.addSeparator();

        menu.addItem((item) => {
            item.setTitle('Create New Group...')
                .setIcon('folder-plus')
                .onClick(async () => {
                    new CreateGroupModal(this.app, this.plugin, async (result) => {
                        if (result && result.name) {
                            await this.plugin.createGroup(result.name, {
                                icon: result.icon,
                                color: result.color,
                                parentGroup: result.parentGroup
                            });
                            await this.plugin.addToGroup(bookmark.url, result.name);
                            new Notice(`Created group "${result.name}" and added bookmark`);
                        }
                    }).open();
                });
        });

        menu.showAtMouseEvent(event);
    }

    onClose() {
        this.contentEl.empty();
    }
}

class EditBookmarkModal extends Modal {
    constructor(app, plugin, bookmark) {
        super(app);
        this.plugin = plugin;
        this.bookmark = bookmark;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('frontpage-edit-modal');
        contentEl.createEl('h3', { text: 'Edit Bookmark' });

        // URL input
        const urlContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        urlContainer.createEl('label', { text: 'URL' });
        const urlInput = urlContainer.createEl('input', {
            cls: 'frontpage-modal-input',
            attr: { type: 'url' }
        });
        urlInput.value = this.bookmark.url;

        // Title input
        const titleContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        titleContainer.createEl('label', { text: 'Title' });
        const titleInput = titleContainer.createEl('input', {
            cls: 'frontpage-modal-input',
            attr: { type: 'text' }
        });
        titleInput.value = this.bookmark.title;

        // Description input
        const descContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        descContainer.createEl('label', { text: 'Description' });
        const descInput = descContainer.createEl('input', {
            cls: 'frontpage-modal-input',
            attr: { type: 'text' }
        });
        descInput.value = this.bookmark.description || '';

        // Tags input with autocomplete
        const tagsContainer = contentEl.createEl('div', { cls: 'frontpage-modal-field' });
        tagsContainer.createEl('label', { text: 'Tags' });
        const tagInput = new TagAutocompleteInput(tagsContainer, this.plugin, this.bookmark.tags || []);

        const buttonContainer = contentEl.createEl('div', { cls: 'frontpage-modal-buttons' });

        const saveBtn = buttonContainer.createEl('button', { cls: 'mod-cta', text: 'Save' });
        saveBtn.addEventListener('click', async () => {
            const url = urlInput.value.trim();
            const title = titleInput.value.trim();
            const description = descInput.value.trim();
            const tags = tagInput.getTags();

            if (!url || !title) {
                new Notice('URL and title are required');
                return;
            }

            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                new Notice('URL must start with http:// or https://');
                return;
            }

            await this.plugin.updateBookmark(this.bookmark.url, {
                url,
                title,
                description,
                tags
            });

            new Notice('Bookmark updated!');
            this.close();
        });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        titleInput.focus();
        titleInput.select();
    }

    onClose() {
        this.contentEl.empty();
    }
}

// ========== CLEANUP ASSISTANT MODAL ==========

class CleanupAssistantModal extends Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.currentStep = 'overview'; // overview, never-clicked, dormant, confirm, summary
        this.selectedUrls = new Set();
        this.action = 'archive'; // archive, delete, keep
        this.dormantThreshold = plugin.settings.dormantDaysThreshold || 30;
        this.results = null;
    }

    onOpen() {
        this.modalEl.addClass('frontpage-cleanup-modal');
        this.render();
    }

    render() {
        const { contentEl } = this;
        contentEl.empty();

        // Progress indicator
        this.renderProgressIndicator(contentEl);

        // Render current step
        switch (this.currentStep) {
            case 'overview':
                this.renderOverview(contentEl);
                break;
            case 'never-clicked':
                this.renderNeverClickedStep(contentEl);
                break;
            case 'dormant':
                this.renderDormantStep(contentEl);
                break;
            case 'confirm':
                this.renderConfirmStep(contentEl);
                break;
            case 'summary':
                this.renderSummary(contentEl);
                break;
        }
    }

    renderProgressIndicator(container) {
        const steps = ['overview', 'never-clicked', 'dormant', 'confirm', 'summary'];
        const stepNames = {
            'overview': 'Overview',
            'never-clicked': 'Never Clicked',
            'dormant': 'Dormant',
            'confirm': 'Confirm',
            'summary': 'Summary'
        };

        const progressBar = container.createEl('div', { cls: 'frontpage-cleanup-progress' });

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const stepIndex = steps.indexOf(this.currentStep);
            const isActive = step === this.currentStep;
            const isCompleted = i < stepIndex;

            const stepEl = progressBar.createEl('div', {
                cls: `frontpage-cleanup-step ${isActive ? 'is-active' : ''} ${isCompleted ? 'is-completed' : ''}`
            });

            stepEl.createEl('div', { cls: 'frontpage-cleanup-step-number', text: `${i + 1}` });
            stepEl.createEl('div', { cls: 'frontpage-cleanup-step-name', text: stepNames[step] });

            if (i < steps.length - 1) {
                progressBar.createEl('div', {
                    cls: `frontpage-cleanup-step-connector ${isCompleted ? 'is-completed' : ''}`
                });
            }
        }
    }

    renderOverview(container) {
        const header = container.createEl('div', { cls: 'frontpage-cleanup-header' });
        header.createEl('h2', { text: 'Cleanup Assistant' });
        header.createEl('p', {
            cls: 'frontpage-cleanup-desc',
            text: 'This wizard will help you identify and manage unused bookmarks. You\'ll review never-clicked and dormant bookmarks, then choose what to do with them.'
        });

        const stats = this.plugin.getAnalyticsSummary();
        const neverClickedBookmarks = Object.values(this.plugin.settings.bookmarks)
            .filter(b => !b.clickCount || b.clickCount === 0);
        const dormantBookmarks = this.plugin.getDormantBookmarks(this.dormantThreshold);

        const statsGrid = container.createEl('div', { cls: 'frontpage-cleanup-stats-grid' });

        this.createStatCard(statsGrid, 'Total Bookmarks', stats.totalBookmarks.toString(), '📚');
        this.createStatCard(statsGrid, 'Never Clicked', neverClickedBookmarks.length.toString(), '🚫',
            neverClickedBookmarks.length > 0 ? 'warning' : 'success');
        this.createStatCard(statsGrid, `Dormant (${this.dormantThreshold}+ days)`, dormantBookmarks.length.toString(), '😴',
            dormantBookmarks.length > 0 ? 'warning' : 'success');
        this.createStatCard(statsGrid, 'Active Bookmarks', stats.activeBookmarks.toString(), '✅', 'success');

        const footer = container.createEl('div', { cls: 'frontpage-cleanup-footer' });

        const cancelBtn = footer.createEl('button', { cls: 'frontpage-cleanup-btn', text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        const startBtn = footer.createEl('button', {
            cls: 'frontpage-cleanup-btn frontpage-cleanup-btn-primary',
            text: 'Start Cleanup'
        });
        startBtn.addEventListener('click', () => {
            this.selectedUrls.clear();
            this.currentStep = 'never-clicked';
            this.render();
        });
    }

    createStatCard(container, label, value, icon, status = 'neutral') {
        const card = container.createEl('div', { cls: `frontpage-cleanup-stat-card frontpage-cleanup-stat-${status}` });
        card.createEl('div', { cls: 'frontpage-cleanup-stat-icon', text: icon });
        card.createEl('div', { cls: 'frontpage-cleanup-stat-value', text: value });
        card.createEl('div', { cls: 'frontpage-cleanup-stat-label', text: label });
    }

    renderNeverClickedStep(container) {
        const header = container.createEl('div', { cls: 'frontpage-cleanup-header' });
        header.createEl('h2', { text: 'Never Clicked Bookmarks' });
        header.createEl('p', {
            cls: 'frontpage-cleanup-desc',
            text: 'These bookmarks have never been clicked. Select the ones you\'d like to clean up.'
        });

        const neverClickedBookmarks = Object.values(this.plugin.settings.bookmarks)
            .filter(b => !b.clickCount || b.clickCount === 0)
            .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

        if (neverClickedBookmarks.length === 0) {
            container.createEl('div', {
                cls: 'frontpage-cleanup-empty',
                text: 'Great! You have no never-clicked bookmarks.'
            });
        } else {
            // Select all / Deselect all buttons
            const selectionControls = container.createEl('div', { cls: 'frontpage-cleanup-selection-controls' });

            const selectAllBtn = selectionControls.createEl('button', {
                cls: 'frontpage-cleanup-selection-btn',
                text: 'Select All'
            });
            selectAllBtn.addEventListener('click', () => {
                for (const bookmark of neverClickedBookmarks) {
                    const url = this.plugin.normalizeUrl(bookmark.url);
                    this.selectedUrls.add(url);
                }
                this.render();
            });

            const deselectAllBtn = selectionControls.createEl('button', {
                cls: 'frontpage-cleanup-selection-btn',
                text: 'Deselect All'
            });
            deselectAllBtn.addEventListener('click', () => {
                for (const bookmark of neverClickedBookmarks) {
                    const url = this.plugin.normalizeUrl(bookmark.url);
                    this.selectedUrls.delete(url);
                }
                this.render();
            });

            selectionControls.createEl('span', {
                cls: 'frontpage-cleanup-selection-count',
                text: `${this.selectedUrls.size} selected`
            });

            const list = container.createEl('div', { cls: 'frontpage-cleanup-list' });

            for (const bookmark of neverClickedBookmarks) {
                const url = this.plugin.normalizeUrl(bookmark.url);
                const isSelected = this.selectedUrls.has(url);

                const item = list.createEl('div', {
                    cls: `frontpage-cleanup-item ${isSelected ? 'is-selected' : ''}`
                });

                const checkbox = item.createEl('input', {
                    cls: 'frontpage-cleanup-checkbox',
                    attr: { type: 'checkbox' }
                });
                checkbox.checked = isSelected;
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) {
                        this.selectedUrls.add(url);
                    } else {
                        this.selectedUrls.delete(url);
                    }
                    item.toggleClass('is-selected', checkbox.checked);
                    const countEl = container.querySelector('.frontpage-cleanup-selection-count');
                    if (countEl) countEl.textContent = `${this.selectedUrls.size} selected`;
                });

                const info = item.createEl('div', { cls: 'frontpage-cleanup-item-info' });
                info.createEl('div', { cls: 'frontpage-cleanup-item-title', text: bookmark.title });

                const addedDate = bookmark.createdAt ? new Date(bookmark.createdAt).toLocaleDateString() : 'Unknown';
                info.createEl('div', { cls: 'frontpage-cleanup-item-meta', text: `Added ${addedDate}` });
            }
        }

        this.renderNavigationFooter(container, 'overview', 'dormant', 'Back', 'Next: Dormant');
    }

    renderDormantStep(container) {
        const header = container.createEl('div', { cls: 'frontpage-cleanup-header' });
        header.createEl('h2', { text: 'Dormant Bookmarks' });
        header.createEl('p', {
            cls: 'frontpage-cleanup-desc',
            text: `These bookmarks haven't been accessed in ${this.dormantThreshold}+ days. Select any additional bookmarks to clean up.`
        });

        // Threshold selector
        const thresholdContainer = container.createEl('div', { cls: 'frontpage-cleanup-threshold' });
        thresholdContainer.createEl('span', { text: 'Dormant threshold: ' });
        const thresholdSelect = thresholdContainer.createEl('select', { cls: 'frontpage-cleanup-threshold-select' });

        for (const days of [7, 14, 30, 60, 90]) {
            const option = thresholdSelect.createEl('option', {
                text: `${days} days`,
                attr: { value: days.toString() }
            });
            if (days === this.dormantThreshold) option.selected = true;
        }

        thresholdSelect.addEventListener('change', () => {
            this.dormantThreshold = parseInt(thresholdSelect.value);
            this.render();
        });

        const dormantBookmarks = this.plugin.getDormantBookmarks(this.dormantThreshold)
            .filter(b => b.clickCount > 0) // Exclude never-clicked (handled in previous step)
            .sort((a, b) => (a.lastAccessedAt || 0) - (b.lastAccessedAt || 0));

        if (dormantBookmarks.length === 0) {
            container.createEl('div', {
                cls: 'frontpage-cleanup-empty',
                text: 'Great! You have no dormant bookmarks (with clicks) beyond the threshold.'
            });
        } else {
            // Select all / Deselect all buttons
            const selectionControls = container.createEl('div', { cls: 'frontpage-cleanup-selection-controls' });

            const selectAllBtn = selectionControls.createEl('button', {
                cls: 'frontpage-cleanup-selection-btn',
                text: 'Select All Dormant'
            });
            selectAllBtn.addEventListener('click', () => {
                for (const bookmark of dormantBookmarks) {
                    const url = this.plugin.normalizeUrl(bookmark.url);
                    this.selectedUrls.add(url);
                }
                this.render();
            });

            const dormantSelectedCount = dormantBookmarks.filter(b =>
                this.selectedUrls.has(this.plugin.normalizeUrl(b.url))
            ).length;

            selectionControls.createEl('span', {
                cls: 'frontpage-cleanup-selection-count',
                text: `${dormantSelectedCount} dormant selected (${this.selectedUrls.size} total)`
            });

            const list = container.createEl('div', { cls: 'frontpage-cleanup-list' });

            for (const bookmark of dormantBookmarks) {
                const url = this.plugin.normalizeUrl(bookmark.url);
                const isSelected = this.selectedUrls.has(url);

                const item = list.createEl('div', {
                    cls: `frontpage-cleanup-item ${isSelected ? 'is-selected' : ''}`
                });

                const checkbox = item.createEl('input', {
                    cls: 'frontpage-cleanup-checkbox',
                    attr: { type: 'checkbox' }
                });
                checkbox.checked = isSelected;
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) {
                        this.selectedUrls.add(url);
                    } else {
                        this.selectedUrls.delete(url);
                    }
                    item.toggleClass('is-selected', checkbox.checked);
                    this.updateDormantSelectionCount(container, dormantBookmarks);
                });

                const info = item.createEl('div', { cls: 'frontpage-cleanup-item-info' });
                info.createEl('div', { cls: 'frontpage-cleanup-item-title', text: bookmark.title });

                const lastAccessed = bookmark.lastAccessedAt
                    ? new Date(bookmark.lastAccessedAt).toLocaleDateString()
                    : 'Never';
                const daysSince = bookmark.lastAccessedAt
                    ? Math.floor((Date.now() - bookmark.lastAccessedAt) / (24 * 60 * 60 * 1000))
                    : 'N/A';

                info.createEl('div', {
                    cls: 'frontpage-cleanup-item-meta',
                    text: `Last accessed: ${lastAccessed} (${daysSince} days ago) • ${bookmark.clickCount} clicks`
                });
            }
        }

        this.renderNavigationFooter(container, 'never-clicked', 'confirm', 'Back', 'Next: Choose Action');
    }

    updateDormantSelectionCount(container, dormantBookmarks) {
        const dormantSelectedCount = dormantBookmarks.filter(b =>
            this.selectedUrls.has(this.plugin.normalizeUrl(b.url))
        ).length;
        const countEl = container.querySelector('.frontpage-cleanup-selection-count');
        if (countEl) {
            countEl.textContent = `${dormantSelectedCount} dormant selected (${this.selectedUrls.size} total)`;
        }
    }

    renderConfirmStep(container) {
        const header = container.createEl('div', { cls: 'frontpage-cleanup-header' });
        header.createEl('h2', { text: 'Choose Action' });
        header.createEl('p', {
            cls: 'frontpage-cleanup-desc',
            text: `You've selected ${this.selectedUrls.size} bookmark${this.selectedUrls.size !== 1 ? 's' : ''} to clean up. What would you like to do with them?`
        });

        if (this.selectedUrls.size === 0) {
            container.createEl('div', {
                cls: 'frontpage-cleanup-empty',
                text: 'No bookmarks selected. Go back to select bookmarks to clean up, or skip to finish.'
            });
        } else {
            const actionsContainer = container.createEl('div', { cls: 'frontpage-cleanup-actions-grid' });

            // Archive option
            const archiveOption = actionsContainer.createEl('div', {
                cls: `frontpage-cleanup-action-option ${this.action === 'archive' ? 'is-selected' : ''}`
            });
            archiveOption.createEl('div', { cls: 'frontpage-cleanup-action-icon', text: '📦' });
            archiveOption.createEl('div', { cls: 'frontpage-cleanup-action-title', text: 'Archive' });
            archiveOption.createEl('div', {
                cls: 'frontpage-cleanup-action-desc',
                text: 'Move to archive. Can be restored later.'
            });
            archiveOption.addEventListener('click', () => {
                this.action = 'archive';
                this.render();
            });

            // Delete option
            const deleteOption = actionsContainer.createEl('div', {
                cls: `frontpage-cleanup-action-option ${this.action === 'delete' ? 'is-selected' : ''}`
            });
            deleteOption.createEl('div', { cls: 'frontpage-cleanup-action-icon', text: '🗑️' });
            deleteOption.createEl('div', { cls: 'frontpage-cleanup-action-title', text: 'Delete Permanently' });
            deleteOption.createEl('div', {
                cls: 'frontpage-cleanup-action-desc',
                text: 'Remove forever. Cannot be undone.'
            });
            deleteOption.addEventListener('click', () => {
                this.action = 'delete';
                this.render();
            });

            // Keep option
            const keepOption = actionsContainer.createEl('div', {
                cls: `frontpage-cleanup-action-option ${this.action === 'keep' ? 'is-selected' : ''}`
            });
            keepOption.createEl('div', { cls: 'frontpage-cleanup-action-icon', text: '✅' });
            keepOption.createEl('div', { cls: 'frontpage-cleanup-action-title', text: 'Keep All' });
            keepOption.createEl('div', {
                cls: 'frontpage-cleanup-action-desc',
                text: 'Do nothing. Keep all selected bookmarks.'
            });
            keepOption.addEventListener('click', () => {
                this.action = 'keep';
                this.render();
            });
        }

        const footer = container.createEl('div', { cls: 'frontpage-cleanup-footer' });

        const backBtn = footer.createEl('button', { cls: 'frontpage-cleanup-btn', text: 'Back' });
        backBtn.addEventListener('click', () => {
            this.currentStep = 'dormant';
            this.render();
        });

        const executeBtn = footer.createEl('button', {
            cls: 'frontpage-cleanup-btn frontpage-cleanup-btn-primary',
            text: this.selectedUrls.size === 0 || this.action === 'keep' ? 'Finish' : `${this.action === 'archive' ? 'Archive' : 'Delete'} ${this.selectedUrls.size} Bookmarks`
        });
        if (this.action === 'delete' && this.selectedUrls.size > 0) {
            executeBtn.addClass('frontpage-cleanup-btn-danger');
        }
        executeBtn.addEventListener('click', async () => {
            await this.executeCleanup();
        });
    }

    async executeCleanup() {
        if (this.selectedUrls.size === 0 || this.action === 'keep') {
            this.results = { action: 'keep', count: 0 };
            this.currentStep = 'summary';
            this.render();
            return;
        }

        let successCount = 0;
        const totalCount = this.selectedUrls.size;

        for (const url of this.selectedUrls) {
            try {
                if (this.action === 'archive') {
                    await this.plugin.archiveBookmark(url);
                } else {
                    await this.plugin.deleteBookmark(url);
                }
                successCount++;
            } catch (e) {
                console.error(`Failed to ${this.action} bookmark:`, url, e);
            }
        }

        this.results = {
            action: this.action,
            count: successCount,
            totalCount
        };

        this.currentStep = 'summary';
        this.render();
    }

    renderSummary(container) {
        const header = container.createEl('div', { cls: 'frontpage-cleanup-header' });
        header.createEl('h2', { text: 'Cleanup Complete!' });

        const summaryContent = container.createEl('div', { cls: 'frontpage-cleanup-summary' });

        if (this.results.action === 'keep' || this.results.count === 0) {
            summaryContent.createEl('div', { cls: 'frontpage-cleanup-summary-icon', text: '✅' });
            summaryContent.createEl('div', {
                cls: 'frontpage-cleanup-summary-text',
                text: 'No changes were made. All bookmarks were kept.'
            });
        } else {
            const icon = this.results.action === 'archive' ? '📦' : '🗑️';
            const actionText = this.results.action === 'archive' ? 'archived' : 'deleted';

            summaryContent.createEl('div', { cls: 'frontpage-cleanup-summary-icon', text: icon });
            summaryContent.createEl('div', {
                cls: 'frontpage-cleanup-summary-text',
                text: `Successfully ${actionText} ${this.results.count} bookmark${this.results.count !== 1 ? 's' : ''}.`
            });

            if (this.results.action === 'archive') {
                summaryContent.createEl('div', {
                    cls: 'frontpage-cleanup-summary-hint',
                    text: 'You can restore archived bookmarks from the Archive section.'
                });
            }
        }

        const footer = container.createEl('div', { cls: 'frontpage-cleanup-footer' });

        const doneBtn = footer.createEl('button', {
            cls: 'frontpage-cleanup-btn frontpage-cleanup-btn-primary',
            text: 'Done'
        });
        doneBtn.addEventListener('click', () => this.close());
    }

    renderNavigationFooter(container, prevStep, nextStep, prevText, nextText) {
        const footer = container.createEl('div', { cls: 'frontpage-cleanup-footer' });

        const backBtn = footer.createEl('button', { cls: 'frontpage-cleanup-btn', text: prevText });
        backBtn.addEventListener('click', () => {
            this.currentStep = prevStep;
            this.render();
        });

        const nextBtn = footer.createEl('button', {
            cls: 'frontpage-cleanup-btn frontpage-cleanup-btn-primary',
            text: nextText
        });
        nextBtn.addEventListener('click', () => {
            this.currentStep = nextStep;
            this.render();
        });
    }

    onClose() {
        this.contentEl.empty();
        // Refresh views after cleanup
        this.plugin.refreshViews();
    }
}

// ========== EXPORT/IMPORT MODALS ==========

class ExportBookmarksModal extends Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.exportOptions = {
            bookmarks: true,
            groups: true,
            favorites: true,
            analytics: true,
            archive: true,
            settings: true,
            tagCollections: true,
            presets: true
        };
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('frontpage-export-modal');

        contentEl.createEl('h3', { text: 'Export Bookmarks & Settings' });
        contentEl.createEl('p', {
            cls: 'frontpage-export-desc',
            text: 'Choose what to include in your export file. The exported JSON file can be imported later or shared with others.'
        });

        // Export options
        const optionsContainer = contentEl.createEl('div', { cls: 'frontpage-export-options' });

        this.createExportOption(optionsContainer, 'bookmarks', 'Bookmarks',
            `${Object.keys(this.plugin.settings.bookmarks).length} bookmarks`);
        this.createExportOption(optionsContainer, 'groups', 'Groups',
            `${Object.keys(this.plugin.settings.groups).length} groups`);
        this.createExportOption(optionsContainer, 'favorites', 'Favorites',
            `${this.plugin.settings.favoriteUrls.length} favorites`);
        this.createExportOption(optionsContainer, 'analytics', 'Analytics Data',
            'Click counts and access times');
        this.createExportOption(optionsContainer, 'archive', 'Archived Bookmarks',
            `${Object.keys(this.plugin.settings.archivedBookmarks || {}).length} archived`);
        this.createExportOption(optionsContainer, 'tagCollections', 'Tag Collections',
            `${Object.keys(this.plugin.settings.tagCollections || {}).length} collections`);
        this.createExportOption(optionsContainer, 'presets', 'Custom Presets',
            `${Object.keys(this.plugin.settings.presets || {}).length} presets`);
        this.createExportOption(optionsContainer, 'settings', 'Display Settings',
            'Layout, view modes, preferences');

        // Preview
        const previewContainer = contentEl.createEl('div', { cls: 'frontpage-export-preview' });
        previewContainer.createEl('div', { cls: 'frontpage-export-preview-label', text: 'Export Preview:' });
        this.previewEl = previewContainer.createEl('div', { cls: 'frontpage-export-preview-content' });
        this.updatePreview();

        // Buttons
        const buttonContainer = contentEl.createEl('div', { cls: 'frontpage-modal-buttons' });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        const exportBtn = buttonContainer.createEl('button', {
            cls: 'mod-cta',
            text: 'Export to File'
        });
        exportBtn.addEventListener('click', () => this.doExport());
    }

    createExportOption(container, key, label, description) {
        const option = container.createEl('label', { cls: 'frontpage-export-option' });

        const checkbox = option.createEl('input', {
            attr: { type: 'checkbox' }
        });
        checkbox.checked = this.exportOptions[key];
        checkbox.addEventListener('change', () => {
            this.exportOptions[key] = checkbox.checked;
            this.updatePreview();
        });

        const textContainer = option.createEl('div', { cls: 'frontpage-export-option-text' });
        textContainer.createEl('div', { cls: 'frontpage-export-option-label', text: label });
        textContainer.createEl('div', { cls: 'frontpage-export-option-desc', text: description });
    }

    updatePreview() {
        const data = this.createExportData();
        const counts = [];

        if (data.data.bookmarks) {
            counts.push(`${Object.keys(data.data.bookmarks).length} bookmarks`);
        }
        if (data.data.groups) {
            counts.push(`${Object.keys(data.data.groups).length} groups`);
        }
        if (data.data.favoriteUrls) {
            counts.push(`${data.data.favoriteUrls.length} favorites`);
        }
        if (data.data.archivedBookmarks) {
            counts.push(`${Object.keys(data.data.archivedBookmarks).length} archived`);
        }
        if (data.data.tagCollections) {
            counts.push(`${Object.keys(data.data.tagCollections).length} collections`);
        }
        if (data.data.presets) {
            counts.push(`${Object.keys(data.data.presets).length} presets`);
        }
        if (data.data.settings) {
            counts.push('display settings');
        }

        this.previewEl.textContent = counts.length > 0
            ? `Will export: ${counts.join(', ')}`
            : 'Nothing selected to export';
    }

    createExportData() {
        const settings = this.plugin.settings;
        const data = {
            version: '1.0.0',
            exportDate: new Date().toISOString(),
            pluginId: 'bookmark-manager',
            data: {}
        };

        if (this.exportOptions.bookmarks) {
            // Export bookmarks, optionally stripping analytics
            const bookmarks = JSON.parse(JSON.stringify(settings.bookmarks));
            if (!this.exportOptions.analytics) {
                for (const bookmark of Object.values(bookmarks)) {
                    delete bookmark.clickCount;
                    delete bookmark.lastAccessedAt;
                }
            }
            data.data.bookmarks = bookmarks;
        }

        if (this.exportOptions.groups) {
            data.data.groups = JSON.parse(JSON.stringify(settings.groups));
            data.data.groupOrder = [...settings.groupOrder];
        }

        if (this.exportOptions.favorites) {
            data.data.favoriteUrls = [...settings.favoriteUrls];
        }

        if (this.exportOptions.archive) {
            data.data.archivedBookmarks = JSON.parse(JSON.stringify(settings.archivedBookmarks || {}));
        }

        if (this.exportOptions.tagCollections) {
            data.data.tagCollections = JSON.parse(JSON.stringify(settings.tagCollections || {}));
        }

        if (this.exportOptions.presets) {
            data.data.presets = JSON.parse(JSON.stringify(settings.presets || {}));
        }

        if (this.exportOptions.settings) {
            data.data.settings = {
                viewMode: settings.viewMode,
                viewModeSettings: JSON.parse(JSON.stringify(settings.viewModeSettings)),
                showMainHeader: settings.showMainHeader,
                showSectionHeaders: settings.showSectionHeaders,
                dashboardTitle: settings.dashboardTitle,
                sectionHeaderSpacing: settings.sectionHeaderSpacing,
                showBookmarkCounts: settings.showBookmarkCounts,
                sortOrder: settings.sortOrder,
                showTableOfContents: settings.showTableOfContents,
                collapsibleSections: settings.collapsibleSections,
                persistCollapseState: settings.persistCollapseState,
                highlightSearchResults: settings.highlightSearchResults,
                stickyControlsBar: settings.stickyControlsBar,
                enableAnimations: settings.enableAnimations,
                enableCardHoverEffects: settings.enableCardHoverEffects,
                enableCollapseAnimations: settings.enableCollapseAnimations,
                enableKeyboardShortcuts: settings.enableKeyboardShortcuts,
                enableTags: settings.enableTags,
                showFavorites: settings.showFavorites,
                showRecentlyAdded: settings.showRecentlyAdded,
                recentlyAddedCount: settings.recentlyAddedCount,
                enableSmartPaste: settings.enableSmartPaste,
                smartPasteDefaultGroup: settings.smartPasteDefaultGroup,
                showTagCloud: settings.showTagCloud,
                tagFilterMode: settings.tagFilterMode,
                enableAnalytics: settings.enableAnalytics,
                mostUsedCount: settings.mostUsedCount,
                dormantDaysThreshold: settings.dormantDaysThreshold,
                enableArchive: settings.enableArchive,
                archiveRetentionDays: settings.archiveRetentionDays,
                showArchivedSection: settings.showArchivedSection,
                // UI Features
                enableBulkSelection: settings.enableBulkSelection,
                showUncategorized: settings.showUncategorized,
                showOpenAllButtons: settings.showOpenAllButtons,
                showCollections: settings.showCollections,
                // Advanced Features
                enableDuplicateDetection: settings.enableDuplicateDetection,
                enableBrokenLinkDetection: settings.enableBrokenLinkDetection
            };
        }

        return data;
    }

    doExport() {
        const data = this.createExportData();
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const date = new Date().toISOString().split('T')[0];
        const filename = `bookmark-manager-export-${date}.json`;

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        new Notice(`Exported to ${filename}`);
        this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}

class ImportSettingsModal extends Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.importData = null;
        this.importOptions = {
            mode: 'merge', // 'merge' or 'replace'
            bookmarks: true,
            groups: true,
            favorites: true,
            analytics: true,
            archive: true,
            settings: false, // Settings off by default for safety
            tagCollections: true,
            presets: true
        };
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('frontpage-import-modal');

        contentEl.createEl('h3', { text: 'Import Bookmarks & Settings' });

        // File input
        const fileContainer = contentEl.createEl('div', { cls: 'frontpage-import-file' });
        fileContainer.createEl('p', { text: 'Select a previously exported JSON file:' });

        const fileInput = fileContainer.createEl('input', {
            attr: { type: 'file', accept: '.json' }
        });

        this.statusEl = contentEl.createEl('div', { cls: 'frontpage-import-status' });
        this.optionsContainer = contentEl.createEl('div', { cls: 'frontpage-import-options' });
        this.optionsContainer.style.display = 'none';

        // Buttons container (will be populated after file loaded)
        this.buttonContainer = contentEl.createEl('div', { cls: 'frontpage-modal-buttons' });

        const cancelBtn = this.buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (file) {
                await this.loadFile(file);
            }
        });
    }

    async loadFile(file) {
        this.statusEl.textContent = 'Reading file...';
        this.statusEl.className = 'frontpage-import-status';

        try {
            const text = await file.text();
            const data = JSON.parse(text);

            // Validate structure
            const validation = this.validateImportData(data);
            if (!validation.valid) {
                this.statusEl.textContent = `Invalid file: ${validation.error}`;
                this.statusEl.addClass('frontpage-import-error');
                return;
            }

            this.importData = data;
            this.showImportOptions();

        } catch (error) {
            console.error('Import error:', error);
            this.statusEl.textContent = 'Error: Invalid JSON file';
            this.statusEl.addClass('frontpage-import-error');
        }
    }

    validateImportData(data) {
        if (!data || typeof data !== 'object') {
            return { valid: false, error: 'Not a valid JSON object' };
        }

        if (data.pluginId && data.pluginId !== 'bookmark-manager') {
            return { valid: false, error: 'This file is from a different plugin' };
        }

        if (!data.data || typeof data.data !== 'object') {
            return { valid: false, error: 'Missing data section' };
        }

        // Check for at least some importable content
        const hasContent = data.data.bookmarks || data.data.groups ||
                          data.data.favoriteUrls || data.data.settings ||
                          data.data.archivedBookmarks || data.data.tagCollections ||
                          data.data.presets;

        if (!hasContent) {
            return { valid: false, error: 'No importable content found' };
        }

        return { valid: true };
    }

    showImportOptions() {
        const data = this.importData.data;

        // Show summary
        const summary = [];
        if (data.bookmarks) summary.push(`${Object.keys(data.bookmarks).length} bookmarks`);
        if (data.groups) summary.push(`${Object.keys(data.groups).length} groups`);
        if (data.favoriteUrls) summary.push(`${data.favoriteUrls.length} favorites`);
        if (data.archivedBookmarks) summary.push(`${Object.keys(data.archivedBookmarks).length} archived`);
        if (data.tagCollections) summary.push(`${Object.keys(data.tagCollections).length} collections`);
        if (data.presets) summary.push(`${Object.keys(data.presets).length} presets`);
        if (data.settings) summary.push('display settings');

        const exportDate = this.importData.exportDate
            ? new Date(this.importData.exportDate).toLocaleDateString()
            : 'Unknown';

        this.statusEl.innerHTML = '';
        this.statusEl.createEl('div', {
            cls: 'frontpage-import-summary',
            text: `Found: ${summary.join(', ')}`
        });
        this.statusEl.createEl('div', {
            cls: 'frontpage-import-date',
            text: `Exported on: ${exportDate}`
        });

        // Show options
        this.optionsContainer.empty();
        this.optionsContainer.style.display = 'block';

        // Import mode
        const modeContainer = this.optionsContainer.createEl('div', { cls: 'frontpage-import-mode' });
        modeContainer.createEl('div', { cls: 'frontpage-import-mode-label', text: 'Import Mode:' });

        const modeOptions = modeContainer.createEl('div', { cls: 'frontpage-import-mode-options' });

        const mergeLabel = modeOptions.createEl('label', { cls: 'frontpage-import-mode-option' });
        const mergeRadio = mergeLabel.createEl('input', {
            attr: { type: 'radio', name: 'import-mode', value: 'merge' }
        });
        mergeRadio.checked = true;
        mergeLabel.createEl('span', { text: 'Merge (add new, skip existing)' });

        const replaceLabel = modeOptions.createEl('label', { cls: 'frontpage-import-mode-option' });
        const replaceRadio = replaceLabel.createEl('input', {
            attr: { type: 'radio', name: 'import-mode', value: 'replace' }
        });
        replaceLabel.createEl('span', { text: 'Replace (overwrite all)' });

        mergeRadio.addEventListener('change', () => { this.importOptions.mode = 'merge'; });
        replaceRadio.addEventListener('change', () => { this.importOptions.mode = 'replace'; });

        // What to import
        const whatContainer = this.optionsContainer.createEl('div', { cls: 'frontpage-import-what' });
        whatContainer.createEl('div', { cls: 'frontpage-import-what-label', text: 'Import:' });

        if (data.bookmarks) {
            this.createImportOption(whatContainer, 'bookmarks', 'Bookmarks', true);
        }
        if (data.groups) {
            this.createImportOption(whatContainer, 'groups', 'Groups', true);
        }
        if (data.favoriteUrls) {
            this.createImportOption(whatContainer, 'favorites', 'Favorites', true);
        }
        if (data.bookmarks && Object.values(data.bookmarks).some(b => b.clickCount !== undefined)) {
            this.createImportOption(whatContainer, 'analytics', 'Analytics data', true);
        }
        if (data.archivedBookmarks) {
            this.createImportOption(whatContainer, 'archive', 'Archived bookmarks', true);
        }
        if (data.tagCollections) {
            this.createImportOption(whatContainer, 'tagCollections', 'Tag collections', true);
        }
        if (data.presets) {
            this.createImportOption(whatContainer, 'presets', 'Custom presets', true);
        }
        if (data.settings) {
            this.createImportOption(whatContainer, 'settings', 'Display settings', false);
        }

        // Add import button
        const importBtn = this.buttonContainer.createEl('button', {
            cls: 'mod-cta',
            text: 'Import'
        });
        importBtn.addEventListener('click', () => this.doImport());
    }

    createImportOption(container, key, label, defaultValue) {
        const option = container.createEl('label', { cls: 'frontpage-import-option' });

        const checkbox = option.createEl('input', {
            attr: { type: 'checkbox' }
        });
        checkbox.checked = defaultValue;
        this.importOptions[key] = defaultValue;

        checkbox.addEventListener('change', () => {
            this.importOptions[key] = checkbox.checked;
        });

        option.createEl('span', { text: label });
    }

    async doImport() {
        // Confirm before replacing all data
        if (this.importOptions.mode === 'replace') {
            const confirmed = await new Promise(resolve => {
                new ConfirmModal(
                    this.app,
                    'Replace All Data',
                    'This will DELETE all existing bookmarks, groups, and settings, replacing them with imported data. This cannot be undone. Continue?',
                    () => resolve(true),
                    'Replace All',
                    'Cancel',
                    true
                ).open();
                // If modal closed without confirm, resolve false after a short delay
                setTimeout(() => resolve(false), 100);
            });
            if (!confirmed) return;
        }

        const data = this.importData.data;
        const settings = this.plugin.settings;
        const isReplace = this.importOptions.mode === 'replace';

        const isValidHttpUrl = (url) => {
            return url && (url.startsWith('http://') || url.startsWith('https://'));
        };

        // Prototype pollution protection - skip dangerous keys
        const isDangerousKey = (key) => {
            return key === '__proto__' || key === 'constructor' || key === 'prototype';
        };

        // Sanitize bookmark data to prevent injection and limit sizes
        const sanitizeBookmark = (bookmark) => ({
            id: typeof bookmark.id === 'string' ? bookmark.id.slice(0, 100) : this.plugin.generateId(),
            title: typeof bookmark.title === 'string' ? bookmark.title.slice(0, 500) : 'Untitled',
            url: typeof bookmark.url === 'string' ? bookmark.url.slice(0, 2000) : '',
            description: typeof bookmark.description === 'string' ? bookmark.description.slice(0, 5000) : '',
            tags: Array.isArray(bookmark.tags) ? bookmark.tags.filter(t => typeof t === 'string').map(t => t.slice(0, 100)).slice(0, 50) : [],
            createdAt: typeof bookmark.createdAt === 'number' ? bookmark.createdAt : Date.now(),
            updatedAt: typeof bookmark.updatedAt === 'number' ? bookmark.updatedAt : Date.now(),
            clickCount: typeof bookmark.clickCount === 'number' ? bookmark.clickCount : 0,
            lastAccessedAt: typeof bookmark.lastAccessedAt === 'number' ? bookmark.lastAccessedAt : null
        });

        let imported = { bookmarks: 0, groups: 0, favorites: 0, archived: 0 };
        let skipped = { bookmarks: 0, groups: 0, favorites: 0, invalidUrls: 0 };

        // Import bookmarks
        if (this.importOptions.bookmarks && data.bookmarks) {
            if (isReplace) {
                settings.bookmarks = {};
            }

            for (const [url, bookmark] of Object.entries(data.bookmarks)) {
                // Skip dangerous prototype pollution keys
                if (isDangerousKey(url)) {
                    continue;
                }

                if (!bookmark || typeof bookmark !== 'object') {
                    continue;
                }

                if (!isValidHttpUrl(bookmark.url)) {
                    skipped.invalidUrls++;
                    continue;
                }

                const normalizedUrl = this.plugin.normalizeUrl(bookmark.url);

                // Skip dangerous keys in normalized URL too
                if (isDangerousKey(normalizedUrl)) {
                    continue;
                }

                if (settings.bookmarks[normalizedUrl] && !isReplace) {
                    skipped.bookmarks++;
                    continue;
                }

                // Import sanitized bookmark
                const importedBookmark = sanitizeBookmark(bookmark);

                // Override analytics based on import options
                if (!this.importOptions.analytics) {
                    importedBookmark.clickCount = 0;
                    importedBookmark.lastAccessedAt = null;
                }

                settings.bookmarks[normalizedUrl] = importedBookmark;
                imported.bookmarks++;
            }
        }

        // Import groups
        if (this.importOptions.groups && data.groups) {
            if (isReplace) {
                settings.groups = {};
                settings.groupOrder = [];
            }

            for (const [name, group] of Object.entries(data.groups)) {
                // Skip dangerous prototype pollution keys
                if (isDangerousKey(name)) {
                    continue;
                }

                // Sanitize group name
                const safeName = typeof name === 'string' ? name.slice(0, 200) : '';
                if (!safeName) continue;

                if (settings.groups[safeName] && !isReplace) {
                    // Merge URLs into existing group
                    const existingUrls = new Set(settings.groups[safeName].urls);
                    for (const url of (group.urls || [])) {
                        if (typeof url === 'string' && settings.bookmarks[url]) {
                            existingUrls.add(url);
                        }
                    }
                    settings.groups[safeName].urls = [...existingUrls];
                    skipped.groups++;
                } else {
                    // Add new group, filtering to existing bookmarks
                    const validUrls = (group.urls || [])
                        .filter(url => typeof url === 'string' && settings.bookmarks[url]);
                    settings.groups[safeName] = {
                        urls: validUrls,
                        icon: typeof group.icon === 'string' ? group.icon.slice(0, 10) : '📁',
                        color: typeof group.color === 'string' ? group.color.slice(0, 50) : null,
                        createdAt: typeof group.createdAt === 'number' ? group.createdAt : Date.now()
                    };
                    if (!settings.groupOrder.includes(safeName)) {
                        settings.groupOrder.push(safeName);
                    }
                    imported.groups++;
                }
            }

            // Import group order if replacing
            if (isReplace && data.groupOrder) {
                settings.groupOrder = data.groupOrder
                    .filter(name => typeof name === 'string' && !isDangerousKey(name) && settings.groups[name]);
            }
        }

        // Import favorites
        if (this.importOptions.favorites && data.favoriteUrls) {
            if (isReplace) {
                settings.favoriteUrls = [];
            }

            for (const url of data.favoriteUrls) {
                if (typeof url === 'string' && !isDangerousKey(url) &&
                    settings.bookmarks[url] && !settings.favoriteUrls.includes(url)) {
                    settings.favoriteUrls.push(url);
                    imported.favorites++;
                } else {
                    skipped.favorites++;
                }
            }
        }

        // Import archived bookmarks
        if (this.importOptions.archive && data.archivedBookmarks) {
            if (!settings.archivedBookmarks) {
                settings.archivedBookmarks = {};
            }

            if (isReplace) {
                settings.archivedBookmarks = {};
            }

            for (const [url, archived] of Object.entries(data.archivedBookmarks)) {
                // Skip dangerous prototype pollution keys
                if (isDangerousKey(url)) {
                    continue;
                }

                if (!archived || typeof archived !== 'object') {
                    continue;
                }

                if (!settings.archivedBookmarks[url] || isReplace) {
                    // Sanitize archived bookmark using the same sanitizer
                    const sanitized = sanitizeBookmark(archived);
                    settings.archivedBookmarks[url] = {
                        ...sanitized,
                        archivedAt: typeof archived.archivedAt === 'number' ? archived.archivedAt : Date.now(),
                        originalGroups: Array.isArray(archived.originalGroups)
                            ? archived.originalGroups.filter(g => typeof g === 'string').slice(0, 50)
                            : [],
                        wasFavorite: typeof archived.wasFavorite === 'boolean' ? archived.wasFavorite : false
                    };
                    imported.archived++;
                }
            }
        }

        // Import tag collections
        if (this.importOptions.tagCollections && data.tagCollections) {
            if (isReplace) {
                settings.tagCollections = {};
            }

            for (const [name, tags] of Object.entries(data.tagCollections)) {
                // Skip dangerous prototype pollution keys
                if (isDangerousKey(name)) {
                    continue;
                }

                const safeName = typeof name === 'string' ? name.slice(0, 200) : '';
                if (!safeName) continue;

                if (!settings.tagCollections[safeName] || isReplace) {
                    // Sanitize tags array
                    settings.tagCollections[safeName] = Array.isArray(tags)
                        ? tags.filter(t => typeof t === 'string').map(t => t.slice(0, 100)).slice(0, 50)
                        : [];
                }
            }
        }

        // Import presets
        if (this.importOptions.presets && data.presets) {
            if (isReplace) {
                settings.presets = {};
            }

            for (const [name, preset] of Object.entries(data.presets)) {
                // Skip dangerous prototype pollution keys
                if (isDangerousKey(name)) {
                    continue;
                }

                const safeName = typeof name === 'string' ? name.slice(0, 200) : '';
                if (!safeName || !preset || typeof preset !== 'object') continue;

                if (!settings.presets[safeName] || isReplace) {
                    // Only allow safe preset properties
                    settings.presets[safeName] = {
                        viewMode: typeof preset.viewMode === 'string' ? preset.viewMode.slice(0, 50) : 'grid',
                        viewModeSettings: preset.viewModeSettings && typeof preset.viewModeSettings === 'object'
                            ? JSON.parse(JSON.stringify(preset.viewModeSettings))
                            : {}
                    };
                }
            }
        }

        // Import settings
        if (this.importOptions.settings && data.settings) {
            // List of allowed setting keys to prevent arbitrary property injection
            const allowedSettingKeys = [
                'viewMode', 'viewModeSettings', 'showMainHeader', 'showSectionHeaders',
                'dashboardTitle', 'sectionHeaderSpacing', 'showBookmarkCounts', 'sortOrder',
                'showTableOfContents', 'collapsibleSections', 'persistCollapseState',
                'highlightSearchResults', 'stickyControlsBar', 'enableAnimations',
                'enableCardHoverEffects', 'enableCollapseAnimations', 'enableKeyboardShortcuts',
                'enableTags', 'showFavorites', 'showRecentlyAdded',
                'recentlyAddedCount', 'enableSmartPaste', 'smartPasteDefaultGroup',
                'showTagCloud', 'tagFilterMode', 'enableAnalytics', 'mostUsedCount',
                'dormantDaysThreshold', 'enableArchive', 'archiveRetentionDays',
                'showArchivedSection', 'enableBulkSelection', 'showUncategorized',
                'showOpenAllButtons', 'showCollections', 'enableDuplicateDetection',
                'enableBrokenLinkDetection'
            ];

            for (const [key, value] of Object.entries(data.settings)) {
                // Skip dangerous keys and non-allowed keys
                if (isDangerousKey(key) || !allowedSettingKeys.includes(key)) {
                    continue;
                }

                if (key === 'viewModeSettings' && typeof value === 'object' && value !== null) {
                    // Deep merge view mode settings with validation
                    for (const [mode, modeSettings] of Object.entries(value)) {
                        if (isDangerousKey(mode)) continue;
                        if (settings.viewModeSettings[mode] && typeof modeSettings === 'object' && modeSettings !== null) {
                            settings.viewModeSettings[mode] = {
                                ...settings.viewModeSettings[mode],
                                ...modeSettings
                            };
                        }
                    }
                } else {
                    settings[key] = value;
                }
            }
        }

        // Validate and save
        this.plugin.validateSettings();
        await this.plugin.saveSettings();

        // Show result
        const results = [];
        if (imported.bookmarks > 0) results.push(`${imported.bookmarks} bookmarks`);
        if (imported.groups > 0) results.push(`${imported.groups} groups`);
        if (imported.favorites > 0) results.push(`${imported.favorites} favorites`);
        if (imported.archived > 0) results.push(`${imported.archived} archived`);

        const skippedTotal = skipped.bookmarks + skipped.groups + skipped.favorites;
        const skippedParts = [];
        if (skippedTotal > 0) skippedParts.push(`${skippedTotal} duplicates`);
        if (skipped.invalidUrls > 0) skippedParts.push(`${skipped.invalidUrls} invalid URLs`);
        const skippedMsg = skippedParts.length > 0 ? ` (${skippedParts.join(', ')} skipped)` : '';

        new Notice(`Imported: ${results.join(', ')}${skippedMsg}`);
        this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}

// ========== SETTINGS TAB ==========

class FrontpageSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
        this.demoCardContainer = null;
        this.activeViewModeTab = null;
        // Debounced save for slider performance
        this.debouncedSave = debounce(async () => {
            await this.plugin.saveSettings();
        }, 300);
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('frontpage-settings');

        const settings = this.plugin.settings;

        // ============ VIEW MODE SETTINGS (Primary Section) ============
        containerEl.createEl('h2', { text: 'View Mode Settings' });
        containerEl.createEl('p', {
            cls: 'setting-item-description',
            text: 'Configure layout and display settings for each view mode. Changes preview in real-time.'
        });

        // Demo card preview (shows multiple cards)
        this.demoCardContainer = containerEl.createEl('div', { cls: 'frontpage-demo-card-container' });

        // Preset selector
        this.createPresetSelector(containerEl, settings);

        // View mode tabs and settings
        this.createViewModeSettings(containerEl, settings);

        // Initial demo card render
        this.updateDemoCard();

        // ============ HEADERS SECTION ============
        containerEl.createEl('h2', { text: 'Headers' });

        new Setting(containerEl)
            .setName('Show main header')
            .setDesc('Display the dashboard title at the top')
            .addToggle(toggle => toggle
                .setValue(settings.showMainHeader)
                .onChange(async (value) => {
                    settings.showMainHeader = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Dashboard title')
            .setDesc('Title shown at the top of the homepage')
            .addText(text => text
                .setValue(settings.dashboardTitle)
                .onChange(async (value) => {
                    settings.dashboardTitle = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Dashboard subtitle')
            .setDesc('Optional subtitle shown below the title')
            .addText(text => text
                .setPlaceholder('e.g., Your personal bookmark library')
                .setValue(settings.dashboardSubtitle || '')
                .onChange(async (value) => {
                    settings.dashboardSubtitle = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Show header statistics')
            .setDesc('Display bookmark, group, and favorite counts in the header')
            .addToggle(toggle => toggle
                .setValue(settings.showHeaderStats)
                .onChange(async (value) => {
                    settings.showHeaderStats = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Show section headers')
            .setDesc('Display headers for each group')
            .addToggle(toggle => toggle
                .setValue(settings.showSectionHeaders)
                .onChange(async (value) => {
                    settings.showSectionHeaders = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Show bookmark counts')
            .setDesc('Display the number of bookmarks in each section')
            .addToggle(toggle => toggle
                .setValue(settings.showBookmarkCounts)
                .onChange(async (value) => {
                    settings.showBookmarkCounts = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Section header spacing')
            .setDesc('Space above section headers in pixels')
            .addSlider(slider => slider
                .setLimits(0, 100, 4)
                .setValue(settings.sectionHeaderSpacing)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.sectionHeaderSpacing = value;
                    await this.plugin.saveSettings();
                }));

        // ============ GROUPING SECTION ============
        containerEl.createEl('h2', { text: 'Grouping' });

        new Setting(containerEl)
            .setName('Sort order')
            .setDesc('How to sort groups')
            .addDropdown(dropdown => dropdown
                .addOption('default', 'Default (as defined)')
                .addOption('alphabetical', 'Alphabetical (A-Z)')
                .addOption('alphabetical-reverse', 'Alphabetical (Z-A)')
                .setValue(settings.sortOrder)
                .onChange(async (value) => {
                    settings.sortOrder = value;
                    await this.plugin.saveSettings();
                }));

        // ============ NAVIGATION SECTION ============
        containerEl.createEl('h2', { text: 'Navigation' });

        new Setting(containerEl)
            .setName('Show table of contents')
            .setDesc('Display a sidebar with links to each section')
            .addToggle(toggle => toggle
                .setValue(settings.showTableOfContents)
                .onChange(async (value) => {
                    settings.showTableOfContents = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Collapsible sections')
            .setDesc('Allow sections to be collapsed/expanded')
            .addToggle(toggle => toggle
                .setValue(settings.collapsibleSections)
                .onChange(async (value) => {
                    settings.collapsibleSections = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Remember collapse state')
            .setDesc('Remember which sections are collapsed between sessions')
            .addToggle(toggle => toggle
                .setValue(settings.persistCollapseState)
                .onChange(async (value) => {
                    settings.persistCollapseState = value;
                    await this.plugin.saveSettings();
                }));

        // ============ SEARCH SECTION ============
        containerEl.createEl('h2', { text: 'Search' });

        new Setting(containerEl)
            .setName('Highlight search results')
            .setDesc('Highlight matching text when searching')
            .addToggle(toggle => toggle
                .setValue(settings.highlightSearchResults)
                .onChange(async (value) => {
                    settings.highlightSearchResults = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Sticky controls bar')
            .setDesc('Keep the search bar visible when scrolling')
            .addToggle(toggle => toggle
                .setValue(settings.stickyControlsBar)
                .onChange(async (value) => {
                    settings.stickyControlsBar = value;
                    await this.plugin.saveSettings();
                }));

        // ============ EFFECTS SECTION ============
        containerEl.createEl('h2', { text: 'Effects' });

        new Setting(containerEl)
            .setName('Enable animations')
            .setDesc('Master toggle for all animations')
            .addToggle(toggle => toggle
                .setValue(settings.enableAnimations)
                .onChange(async (value) => {
                    settings.enableAnimations = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Card hover effects')
            .setDesc('Show visual feedback when hovering over cards')
            .addToggle(toggle => toggle
                .setValue(settings.enableCardHoverEffects)
                .onChange(async (value) => {
                    settings.enableCardHoverEffects = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Collapse animations')
            .setDesc('Animate section collapse/expand')
            .addToggle(toggle => toggle
                .setValue(settings.enableCollapseAnimations)
                .onChange(async (value) => {
                    settings.enableCollapseAnimations = value;
                    await this.plugin.saveSettings();
                }));

        // ============ FEATURES SECTION ============
        containerEl.createEl('h2', { text: 'Features' });

        new Setting(containerEl)
            .setName('Keyboard shortcuts')
            .setDesc('Enable Ctrl/Cmd+F to focus search, Escape to clear')
            .addToggle(toggle => toggle
                .setValue(settings.enableKeyboardShortcuts)
                .onChange(async (value) => {
                    settings.enableKeyboardShortcuts = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Enable tags')
            .setDesc('Display tags on bookmarks')
            .addToggle(toggle => toggle
                .setValue(settings.enableTags)
                .onChange(async (value) => {
                    settings.enableTags = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Bulk selection')
            .setDesc('Show Select button to select multiple bookmarks for batch operations')
            .addToggle(toggle => toggle
                .setValue(settings.enableBulkSelection)
                .onChange(async (value) => {
                    settings.enableBulkSelection = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Open All buttons')
            .setDesc('Show buttons on section headers to open all bookmarks in new tabs')
            .addToggle(toggle => toggle
                .setValue(settings.showOpenAllButtons)
                .onChange(async (value) => {
                    settings.showOpenAllButtons = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Smart Paste')
            .setDesc('Enable the Paste URL button to automatically fetch metadata from clipboard URLs')
            .addToggle(toggle => toggle
                .setValue(settings.enableSmartPaste)
                .onChange(async (value) => {
                    settings.enableSmartPaste = value;
                    await this.plugin.saveSettings();
                }));

        // Smart Paste default group
        const groupNames = Object.keys(settings.groups);
        new Setting(containerEl)
            .setName('Smart Paste default group')
            .setDesc('Automatically assign Smart Paste bookmarks to this group')
            .addDropdown(dropdown => {
                dropdown.addOption('', '(None)');
                for (const name of groupNames) {
                    dropdown.addOption(name, name);
                }
                dropdown
                    .setValue(settings.smartPasteDefaultGroup || '')
                    .onChange(async (value) => {
                        settings.smartPasteDefaultGroup = value;
                        await this.plugin.saveSettings();
                    });
            });

        // ============ SPECIAL SECTIONS ============
        containerEl.createEl('h2', { text: 'Special Sections' });

        new Setting(containerEl)
            .setName('Show Favorites')
            .setDesc('Display a Favorites section at the top')
            .addToggle(toggle => toggle
                .setValue(settings.showFavorites)
                .onChange(async (value) => {
                    settings.showFavorites = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Show Recently Added')
            .setDesc('Display a Recently Added section')
            .addToggle(toggle => toggle
                .setValue(settings.showRecentlyAdded)
                .onChange(async (value) => {
                    settings.showRecentlyAdded = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Show Current Note Section')
            .setDesc('Display bookmarks found in the currently open note at the top (useful in sidebar)')
            .addToggle(toggle => toggle
                .setValue(settings.showCurrentNoteSection)
                .onChange(async (value) => {
                    settings.showCurrentNoteSection = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Show All URLs in Current Note')
            .setDesc('Show all URLs found in the current note, not just ones saved as bookmarks. Unsaved URLs can be quickly added.')
            .addToggle(toggle => toggle
                .setValue(settings.showAllCurrentNoteUrls)
                .onChange(async (value) => {
                    settings.showAllCurrentNoteUrls = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Recently added count')
            .setDesc('Maximum number of recently added bookmarks to show')
            .addSlider(slider => slider
                .setLimits(1, 50, 1)
                .setValue(settings.recentlyAddedCount)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.recentlyAddedCount = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Show Uncategorized')
            .setDesc('Display a section for bookmarks not assigned to any group')
            .addToggle(toggle => toggle
                .setValue(settings.showUncategorized)
                .onChange(async (value) => {
                    settings.showUncategorized = value;
                    await this.plugin.saveSettings();
                }));

        // ============ TAG COLLECTIONS ============
        containerEl.createEl('h2', { text: 'Tag Collections' });

        new Setting(containerEl)
            .setName('Show collections')
            .setDesc('Display saved tag collections as sections on the dashboard')
            .addToggle(toggle => toggle
                .setValue(settings.showCollections)
                .onChange(async (value) => {
                    settings.showCollections = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Show tag cloud')
            .setDesc('Display a cloud of all tags with counts below Recently Added')
            .addToggle(toggle => toggle
                .setValue(settings.showTagCloud)
                .onChange(async (value) => {
                    settings.showTagCloud = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Default tag filter mode')
            .setDesc('How multiple tags are combined when filtering')
            .addDropdown(dropdown => dropdown
                .addOption('AND', 'AND - Match all selected tags')
                .addOption('OR', 'OR - Match any selected tag')
                .setValue(settings.tagFilterMode)
                .onChange(async (value) => {
                    settings.tagFilterMode = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Manage tags')
            .setDesc('Merge or delete tags across all bookmarks')
            .addButton(button => button
                .setButtonText('Manage Tags')
                .onClick(() => {
                    new TagManagementModal(this.app, this.plugin).open();
                }));

        const collectionCount = Object.keys(settings.tagCollections).length;
        new Setting(containerEl)
            .setName('Saved collections')
            .setDesc(`${collectionCount} collection${collectionCount !== 1 ? 's' : ''} saved. Collections are tag combinations you can quickly filter by.`)
            .addButton(button => button
                .setButtonText('Clear All')
                .setDisabled(collectionCount === 0)
                .onClick(async () => {
                    if (collectionCount === 0) return;
                    const confirmModal = new ConfirmModal(
                        this.app,
                        'Delete All Collections',
                        `Are you sure you want to delete all ${collectionCount} saved collections?`,
                        async () => {
                            settings.tagCollections = {};
                            await this.plugin.saveSettings();
                            new Notice('All collections deleted');
                            this.display(); // Refresh settings
                        }
                    );
                    confirmModal.open();
                }));

        // ============ ANALYTICS ============
        containerEl.createEl('h2', { text: 'Usage Analytics' });

        new Setting(containerEl)
            .setName('Enable analytics')
            .setDesc('Track bookmark clicks and access times')
            .addToggle(toggle => toggle
                .setValue(settings.enableAnalytics)
                .onChange(async (value) => {
                    settings.enableAnalytics = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide other analytics options
                }));

        if (settings.enableAnalytics) {
            new Setting(containerEl)
                .setName('Most used count')
                .setDesc('Number of bookmarks to show in Most Used list')
                .addSlider(slider => slider
                    .setLimits(5, 25, 5)
                    .setValue(settings.mostUsedCount || 10)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        settings.mostUsedCount = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Dormant threshold')
                .setDesc('Days without access before a bookmark is considered dormant')
                .addSlider(slider => slider
                    .setLimits(7, 90, 7)
                    .setValue(settings.dormantDaysThreshold || 30)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        settings.dormantDaysThreshold = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('View insights')
                .setDesc('See your most used and dormant bookmarks')
                .addButton(button => button
                    .setButtonText('Open Insights')
                    .onClick(() => {
                        new InsightsModal(this.app, this.plugin).open();
                    }));

            new Setting(containerEl)
                .setName('Reset analytics')
                .setDesc('Clear all click counts and access times')
                .addButton(button => button
                    .setButtonText('Reset')
                    .setWarning()
                    .onClick(() => {
                        new ConfirmModal(
                            this.app,
                            'Reset All Analytics',
                            'This will clear all click counts and access times. This cannot be undone.',
                            async () => {
                                await this.plugin.resetAnalytics();
                                new Notice('Analytics data reset');
                            }
                        ).open();
                    }));
        }

        // ============ ARCHIVE ============
        containerEl.createEl('h2', { text: 'Archive' });

        new Setting(containerEl)
            .setName('Enable archive')
            .setDesc('Archive bookmarks instead of permanently deleting them')
            .addToggle(toggle => toggle
                .setValue(settings.enableArchive)
                .onChange(async (value) => {
                    settings.enableArchive = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        if (settings.enableArchive) {
            new Setting(containerEl)
                .setName('Show archive section')
                .setDesc('Display archived bookmarks at the bottom of the homepage')
                .addToggle(toggle => toggle
                    .setValue(settings.showArchivedSection)
                    .onChange(async (value) => {
                        settings.showArchivedSection = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('Auto-delete after days')
                .setDesc('Automatically delete archived bookmarks after this many days (0 = never)')
                .addSlider(slider => slider
                    .setLimits(0, 90, 7)
                    .setValue(settings.archiveRetentionDays || 30)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        settings.archiveRetentionDays = value;
                        await this.plugin.saveSettings();
                    }));

            const archivedCount = Object.keys(settings.archivedBookmarks || {}).length;
            if (archivedCount > 0) {
                new Setting(containerEl)
                    .setName(`Archive contents (${archivedCount} bookmarks)`)
                    .setDesc('Permanently delete all archived bookmarks')
                    .addButton(button => button
                        .setButtonText('Empty Archive')
                        .setWarning()
                        .onClick(() => {
                            new ConfirmModal(
                                this.app,
                                'Empty Archive',
                                `Permanently delete all ${archivedCount} archived bookmark${archivedCount !== 1 ? 's' : ''}?`,
                                async () => {
                                    const count = await this.plugin.emptyArchive();
                                    new Notice(`Deleted ${count} archived bookmark${count !== 1 ? 's' : ''}`);
                                    this.display();
                                }
                            ).open();
                        }));
            }
        }

        // ============ DATA MANAGEMENT ============
        containerEl.createEl('h2', { text: 'Data Management' });

        new Setting(containerEl)
            .setName('Export data')
            .setDesc('Export bookmarks, groups, settings, and other data to a JSON file')
            .addButton(button => button
                .setButtonText('Export')
                .onClick(() => {
                    new ExportBookmarksModal(this.app, this.plugin).open();
                }));

        new Setting(containerEl)
            .setName('Import data')
            .setDesc('Import bookmarks and settings from a previously exported JSON file')
            .addButton(button => button
                .setButtonText('Import')
                .onClick(() => {
                    new ImportSettingsModal(this.app, this.plugin).open();
                }));

        new Setting(containerEl)
            .setName('Duplicate detection')
            .setDesc('Find and manage duplicate bookmarks')
            .addToggle(toggle => toggle
                .setValue(settings.enableDuplicateDetection)
                .onChange(async (value) => {
                    settings.enableDuplicateDetection = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide button
                }))
            .addExtraButton(button => {
                if (!settings.enableDuplicateDetection) {
                    button.extraSettingsEl.style.display = 'none';
                }
                button
                    .setIcon('search')
                    .setTooltip('Find duplicates')
                    .onClick(async () => {
                        await this.plugin.findDuplicates();
                    });
            });

        new Setting(containerEl)
            .setName('Broken link detection')
            .setDesc('Check for broken or inaccessible bookmark URLs')
            .addToggle(toggle => toggle
                .setValue(settings.enableBrokenLinkDetection)
                .onChange(async (value) => {
                    settings.enableBrokenLinkDetection = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide button
                }))
            .addExtraButton(button => {
                if (!settings.enableBrokenLinkDetection) {
                    button.extraSettingsEl.style.display = 'none';
                }
                button
                    .setIcon('link')
                    .setTooltip('Check for broken links')
                    .onClick(async () => {
                        await this.plugin.checkAllLinks();
                    });
            });

        // ============ STATISTICS ============
        containerEl.createEl('h2', { text: 'Statistics' });

        const totalBookmarks = Object.keys(settings.bookmarks).length;
        const totalGroups = Object.keys(settings.groups).length;
        const totalFavorites = settings.favoriteUrls.length;
        const allTags = this.plugin.getAllTags();
        const totalTags = allTags.size;
        const totalCollections = Object.keys(settings.tagCollections).length;

        containerEl.createEl('p', {
            text: `Total bookmarks: ${totalBookmarks}`
        });
        containerEl.createEl('p', {
            text: `Total groups: ${totalGroups}`
        });
        containerEl.createEl('p', {
            text: `Favorites: ${totalFavorites}`
        });
        containerEl.createEl('p', {
            text: `Unique tags: ${totalTags}`
        });
        containerEl.createEl('p', {
            text: `Saved collections: ${totalCollections}`
        });
    }

    createViewModeSettings(containerEl, settings) {
        const viewModes = ['grid', 'list', 'compact'];
        const viewModeNames = { grid: 'Grid', list: 'List', compact: 'Compact' };

        // Create tabs
        const tabContainer = containerEl.createEl('div', { cls: 'frontpage-view-mode-tabs' });
        const contentContainer = containerEl.createEl('div', { cls: 'frontpage-view-mode-content' });

        let activeTab = settings.viewMode || 'grid';
        this.activeViewModeTab = activeTab;

        const renderTabContent = (mode) => {
            contentContainer.empty();

            // Ensure viewModeSettings exists for this mode
            if (!settings.viewModeSettings) {
                settings.viewModeSettings = {};
            }
            if (!settings.viewModeSettings[mode]) {
                settings.viewModeSettings[mode] = {};
            }
            const modeSettings = settings.viewModeSettings[mode];
            const defaults = VIEW_MODE_DEFAULTS[mode];

            // ---- Layout Settings ----
            contentContainer.createEl('h4', { text: 'Layout', cls: 'frontpage-settings-subheader' });

            // Card minimum width
            new Setting(contentContainer)
                .setName('Card minimum width')
                .setDesc('Minimum width of cards in pixels')
                .addSlider(slider => slider
                    .setLimits(100, 600, 10)
                    .setValue(modeSettings.cardMinWidth ?? defaults.cardMinWidth)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        modeSettings.cardMinWidth = value;
                        this.updateDemoCard();
                        this.debouncedSave();
                    }));

            // Card gap
            new Setting(contentContainer)
                .setName('Card gap')
                .setDesc('Space between cards in pixels')
                .addSlider(slider => slider
                    .setLimits(0, 50, 2)
                    .setValue(modeSettings.cardGap ?? defaults.cardGap)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        modeSettings.cardGap = value;
                        this.updateDemoCard();
                        this.debouncedSave();
                    }));

            // Card padding
            new Setting(contentContainer)
                .setName('Card padding')
                .setDesc('Internal padding of cards in pixels')
                .addSlider(slider => slider
                    .setLimits(0, 50, 2)
                    .setValue(modeSettings.cardPadding ?? defaults.cardPadding)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        modeSettings.cardPadding = value;
                        this.updateDemoCard();
                        this.debouncedSave();
                    }));

            // Border radius
            new Setting(contentContainer)
                .setName('Border radius')
                .setDesc('Card corner roundness in pixels')
                .addSlider(slider => slider
                    .setLimits(0, 30, 1)
                    .setValue(modeSettings.cardBorderRadius ?? defaults.cardBorderRadius)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        modeSettings.cardBorderRadius = value;
                        this.updateDemoCard();
                        this.debouncedSave();
                    }));

            // ---- Display Settings ----
            contentContainer.createEl('h4', { text: 'Display', cls: 'frontpage-settings-subheader' });

            // Show Favicons toggle
            new Setting(contentContainer)
                .setName('Show favicons')
                .setDesc('Display website favicons')
                .addToggle(toggle => toggle
                    .setValue(modeSettings.showFavicons ?? true)
                    .onChange(async (value) => {
                        modeSettings.showFavicons = value;
                        this.updateDemoCard();
                        await this.plugin.saveSettings();
                    }));

            // Favicon size dropdown
            new Setting(contentContainer)
                .setName('Favicon size')
                .setDesc('Size of favicons')
                .addDropdown(dropdown => dropdown
                    .addOption('small', 'Small')
                    .addOption('medium', 'Medium')
                    .addOption('large', 'Large')
                    .setValue(modeSettings.faviconSize ?? 'small')
                    .onChange(async (value) => {
                        modeSettings.faviconSize = value;
                        this.updateDemoCard();
                        await this.plugin.saveSettings();
                    }));

            // Show URLs toggle
            new Setting(contentContainer)
                .setName('Show URLs')
                .setDesc('Display bookmark URLs')
                .addToggle(toggle => toggle
                    .setValue(modeSettings.showUrls ?? true)
                    .onChange(async (value) => {
                        modeSettings.showUrls = value;
                        this.updateDemoCard();
                        await this.plugin.saveSettings();
                    }));

            // Show Descriptions toggle
            new Setting(contentContainer)
                .setName('Show descriptions')
                .setDesc('Display bookmark descriptions')
                .addToggle(toggle => toggle
                    .setValue(modeSettings.showDescriptions ?? true)
                    .onChange(async (value) => {
                        modeSettings.showDescriptions = value;
                        this.updateDemoCard();
                        await this.plugin.saveSettings();
                    }));

            // Show Tags toggle
            new Setting(contentContainer)
                .setName('Show tags')
                .setDesc('Display bookmark tags')
                .addToggle(toggle => toggle
                    .setValue(modeSettings.showTags ?? true)
                    .onChange(async (value) => {
                        modeSettings.showTags = value;
                        this.updateDemoCard();
                        await this.plugin.saveSettings();
                    }));
        };

        // Create tabs
        viewModes.forEach(mode => {
            const tab = tabContainer.createEl('button', {
                cls: `frontpage-view-mode-tab ${mode === activeTab ? 'is-active' : ''}`,
                text: viewModeNames[mode]
            });

            // Add indicator if this is the current view mode
            if (mode === settings.viewMode) {
                tab.createEl('span', { cls: 'frontpage-current-mode-indicator', text: ' •' });
            }

            tab.addEventListener('click', () => {
                // Update active state
                tabContainer.querySelectorAll('.frontpage-view-mode-tab').forEach(t => t.removeClass('is-active'));
                tab.addClass('is-active');
                activeTab = mode;
                this.activeViewModeTab = mode;
                renderTabContent(mode);
                this.updateDemoCard();
            });
        });

        // Render initial content
        renderTabContent(activeTab);
    }

    /**
     * Create the preset selector UI
     */
    createPresetSelector(containerEl, settings) {
        const presetContainer = containerEl.createEl('div', { cls: 'frontpage-preset-container' });

        // Built-in presets row
        const builtInRow = presetContainer.createEl('div', { cls: 'frontpage-preset-row' });
        builtInRow.createEl('span', { cls: 'frontpage-preset-label', text: 'Quick Presets:' });

        const builtInBtns = builtInRow.createEl('div', { cls: 'frontpage-preset-buttons' });
        for (const [name, presetData] of Object.entries(BUILT_IN_PRESETS)) {
            const btn = builtInBtns.createEl('button', { cls: 'frontpage-preset-btn', text: name });
            btn.addEventListener('click', () => this.applyPreset(presetData, name));
        }

        // Custom presets row (if any exist)
        const customPresets = settings.presets || {};
        if (Object.keys(customPresets).length > 0) {
            const customRow = presetContainer.createEl('div', { cls: 'frontpage-preset-row' });
            customRow.createEl('span', { cls: 'frontpage-preset-label', text: 'Custom:' });

            const customBtns = customRow.createEl('div', { cls: 'frontpage-preset-buttons' });
            for (const [name, presetData] of Object.entries(customPresets)) {
                const btnWrapper = customBtns.createEl('div', { cls: 'frontpage-custom-preset-wrapper' });
                const btn = btnWrapper.createEl('button', { cls: 'frontpage-preset-btn frontpage-preset-custom', text: name });
                btn.addEventListener('click', () => this.applyPreset(presetData, name));

                // Delete button
                const deleteBtn = btnWrapper.createEl('button', { cls: 'frontpage-preset-delete', text: '×' });
                deleteBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await this.deleteCustomPreset(name);
                });
            }
        }

        // Save current as preset button
        const saveRow = presetContainer.createEl('div', { cls: 'frontpage-preset-row frontpage-preset-save-row' });
        const saveBtn = saveRow.createEl('button', { cls: 'frontpage-preset-save-btn', text: 'Save Current as Preset...' });
        saveBtn.addEventListener('click', () => this.saveCurrentAsPreset());

        this.presetContainer = presetContainer;
    }

    /**
     * Apply a preset to all view modes
     */
    async applyPreset(presetData, presetName) {
        const settings = this.plugin.settings;

        // Deep copy preset data to viewModeSettings
        for (const mode of ['grid', 'list', 'compact']) {
            if (presetData[mode]) {
                settings.viewModeSettings[mode] = { ...presetData[mode] };
            }
        }

        await this.plugin.saveSettings();

        // Refresh the settings UI
        this.display();

        new Notice(`Applied preset: ${presetName}`);
    }

    /**
     * Save current settings as a custom preset
     */
    saveCurrentAsPreset() {
        new SavePresetModal(this.app, this.plugin, async (name) => {
            const settings = this.plugin.settings;

            if (!settings.presets) settings.presets = {};

            settings.presets[name] = {
                grid: { ...settings.viewModeSettings.grid },
                list: { ...settings.viewModeSettings.list },
                compact: { ...settings.viewModeSettings.compact }
            };

            await this.plugin.saveSettings();
            this.display(); // Refresh settings UI
            new Notice(`Preset "${name}" saved!`);
        }).open();
    }

    /**
     * Delete a custom preset
     */
    async deleteCustomPreset(name) {
        const confirmModal = new ConfirmModal(
            this.app,
            'Delete Preset',
            `Are you sure you want to delete the preset "${name}"?`,
            async () => {
                delete this.plugin.settings.presets[name];
                await this.plugin.saveSettings();
                this.display();
                new Notice(`Preset "${name}" deleted`);
            }
        );
        confirmModal.open();
    }

    /**
     * Update the demo card preview with current settings
     * Shows multiple cards to demonstrate layout and spacing
     */
    updateDemoCard() {
        if (!this.demoCardContainer) return;

        const settings = this.plugin.settings;
        // Use actively selected tab if available, otherwise fall back to saved view mode
        const viewMode = this.activeViewModeTab || settings.viewMode || 'grid';
        const modeSettings = settings.viewModeSettings?.[viewMode] || {};

        // Get layout settings for current view mode (using centralized defaults)
        const defaults = VIEW_MODE_DEFAULTS[viewMode] || VIEW_MODE_DEFAULTS.grid;

        const cardMinWidth = modeSettings.cardMinWidth ?? defaults.cardMinWidth;
        const cardGap = modeSettings.cardGap ?? defaults.cardGap;
        const cardPadding = modeSettings.cardPadding ?? defaults.cardPadding;
        const cardBorderRadius = modeSettings.cardBorderRadius ?? defaults.cardBorderRadius;

        // Get display settings for current view mode
        const showFavicons = modeSettings.showFavicons ?? true;
        const faviconSize = modeSettings.faviconSize ?? 'small';
        const showUrls = modeSettings.showUrls ?? true;
        const showDescriptions = modeSettings.showDescriptions ?? true;
        const showTags = modeSettings.showTags ?? true;

        this.demoCardContainer.empty();

        // Create wrapper with view mode class
        const wrapper = this.demoCardContainer.createEl('div', {
            cls: `frontpage-demo-wrapper view-${viewMode}`
        });

        // Apply CSS custom properties from per-view-mode settings
        wrapper.style.setProperty('--fp-card-min-width', `${cardMinWidth}px`);
        wrapper.style.setProperty('--fp-card-gap', `${cardGap}px`);
        wrapper.style.setProperty('--fp-card-padding', `${cardPadding}px`);
        wrapper.style.setProperty('--fp-card-radius', `${cardBorderRadius}px`);

        // Create grid container for multiple demo cards
        const grid = wrapper.createEl('div', { cls: 'frontpage-grid frontpage-demo-grid' });

        // Demo card data - variety to show real-world usage
        const demoCards = [
            {
                title: 'GitHub',
                domain: 'github.com',
                url: 'github.com/user/project',
                description: 'A platform for version control and collaboration.',
                tags: ['dev', 'code']
            },
            {
                title: 'Documentation',
                domain: 'developer.mozilla.org',
                url: 'developer.mozilla.org/docs',
                description: 'Complete reference guide and tutorials.',
                tags: ['docs']
            },
            {
                title: 'Stack Overflow',
                domain: 'stackoverflow.com',
                url: 'stackoverflow.com/questions',
                description: 'Q&A for programmers and developers.',
                tags: ['dev', 'help']
            }
        ];

        // Create each demo card
        for (const cardData of demoCards) {
            const card = grid.createEl('div', { cls: 'frontpage-card frontpage-demo-card' });

            // Large favicon banner (if large mode)
            if (showFavicons && faviconSize === 'large') {
                const faviconBanner = card.createEl('div', { cls: 'frontpage-favicon-banner' });
                faviconBanner.createEl('img', {
                    cls: 'frontpage-favicon',
                    attr: {
                        src: `https://www.google.com/s2/favicons?domain=${cardData.domain}&sz=96`,
                        width: 48,
                        height: 48,
                        alt: ''
                    }
                });
            }

            // Card header with favicon and title
            const cardHeader = card.createEl('div', { cls: 'frontpage-card-header' });

            // Favicon (small or medium)
            if (showFavicons && faviconSize !== 'large') {
                const iconSize = faviconSize === 'medium' ? 24 : 16;
                const faviconWrapper = cardHeader.createEl('div', {
                    cls: `frontpage-favicon-wrapper frontpage-favicon-${faviconSize}`
                });
                faviconWrapper.createEl('img', {
                    cls: 'frontpage-favicon',
                    attr: {
                        src: `https://www.google.com/s2/favicons?domain=${cardData.domain}&sz=${iconSize * 2}`,
                        width: iconSize,
                        height: iconSize,
                        alt: ''
                    }
                });
            }

            // Title
            cardHeader.createEl('div', { cls: 'frontpage-card-title', text: cardData.title });

            // Description
            if (showDescriptions) {
                card.createEl('div', {
                    cls: 'frontpage-card-description',
                    text: cardData.description
                });
            }

            // URL
            if (showUrls) {
                card.createEl('div', { cls: 'frontpage-card-url', text: cardData.url });
            }

            // Tags
            if (showTags && cardData.tags.length > 0) {
                const tagsContainer = card.createEl('div', { cls: 'frontpage-card-tags' });
                for (const tag of cardData.tags) {
                    tagsContainer.createEl('span', { cls: 'frontpage-tag', text: tag });
                }
            }
        }

        // Label
        wrapper.createEl('div', { cls: 'frontpage-demo-label', text: 'Preview' });
    }
}

// ========== PLUGIN CLASS ==========

module.exports = class FrontpagePlugin extends Plugin {
    // Initialize class properties to prevent undefined access
    _savingSettings = false;
    _pendingSave = null;
    collapsedState = [];
    settings = null;

    async onload() {
        // Load settings with error handling
        try {
            await this.loadSettings();
        } catch (err) {
            console.error('Bookmark Manager: Failed to load settings:', err);
            new Notice('Failed to load Bookmark Manager settings. Please reload Obsidian.');
            return;
        }

        // Auto-cleanup expired archived bookmarks (non-critical, don't block on errors)
        try {
            await this.cleanupOldArchivedBookmarks();
        } catch (err) {
            console.warn('Bookmark Manager: Archive cleanup failed:', err);
            // Continue loading - this isn't critical
        }

        // Schedule periodic archive cleanup (every 24 hours)
        this.registerInterval(window.setInterval(async () => {
            try {
                await this.cleanupOldArchivedBookmarks();
            } catch (err) {
                console.warn('Bookmark Manager: Periodic archive cleanup failed:', err);
            }
        }, 24 * 60 * 60 * 1000));

        this.registerView(
            VIEW_TYPE_BOOKMARK_HOMEPAGE,
            (leaf) => new FrontpageView(leaf, this)
        );

        this.addRibbonIcon('bookmark', 'Open Bookmark Manager', () => {
            this.activateView().catch(err => {
                console.error('Bookmark Manager: Failed to activate view:', err);
                new Notice('Failed to open Bookmark Manager');
            });
        });

        this.addCommand({
            id: 'open-bookmark-manager',
            name: 'Open Bookmark Manager',
            callback: () => {
                this.activateView().catch(err => {
                    console.error('Bookmark Manager: Failed to activate view:', err);
                    new Notice('Failed to open Bookmark Manager');
                });
            }
        });

        this.addCommand({
            id: 'add-bookmark',
            name: 'Add Bookmark',
            callback: () => {
                new QuickAddBookmarkModal(this.app, this).open();
            }
        });

        this.addCommand({
            id: 'check-broken-links',
            name: 'Check for Broken Links',
            checkCallback: (checking) => {
                if (!this.settings.enableBrokenLinkDetection) return false;
                if (checking) return true;
                this.checkAllLinks().catch(err => {
                    console.error('Failed to check links:', err);
                    new Notice('Failed to check links');
                });
                return true;
            }
        });

        this.addCommand({
            id: 'import-bookmarks',
            name: 'Import Bookmarks from Browser',
            callback: () => {
                new ImportBookmarksModal(this.app, this).open();
            }
        });

        this.addCommand({
            id: 'find-duplicates',
            name: 'Find Duplicate Bookmarks',
            checkCallback: (checking) => {
                if (!this.settings.enableDuplicateDetection) return false;
                if (checking) return true;
                this.findDuplicates().catch(err => {
                    console.error('Failed to find duplicates:', err);
                    new Notice('Failed to find duplicates');
                });
                return true;
            }
        });

        this.addSettingTab(new FrontpageSettingTab(this.app, this));
    }

    onunload() {
        // Cancel any pending saves
        if (this._pendingSave) {
            this._pendingSave = null;
        }
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_BOOKMARK_HOMEPAGE);
    }

    async loadSettings() {
        const data = await this.loadData() || {};

        // Deep clone defaults to avoid mutating the original
        this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

        // Merge top-level primitives and arrays (except internal keys)
        for (const [key, value] of Object.entries(data)) {
            if (key.startsWith('_')) continue; // Skip internal keys like _collapsedState
            if (key === 'viewModeSettings') continue; // Handle separately for deep merge
            if (key === 'bookmarks' || key === 'groups') {
                // These are user data, replace entirely
                this.settings[key] = value;
            } else if (value !== undefined) {
                this.settings[key] = value;
            }
        }

        // Deep merge viewModeSettings to preserve defaults for unconfigured modes
        if (data.viewModeSettings && typeof data.viewModeSettings === 'object') {
            for (const [mode, modeSettings] of Object.entries(data.viewModeSettings)) {
                if (this.settings.viewModeSettings[mode] && typeof modeSettings === 'object') {
                    this.settings.viewModeSettings[mode] = {
                        ...this.settings.viewModeSettings[mode],
                        ...modeSettings
                    };
                }
            }
        }

        // Validate and repair potentially corrupted settings
        this.validateSettings();

        // Load persisted collapse state
        this.collapsedState = Array.isArray(data._collapsedState) ? data._collapsedState : [];
    }

    /**
     * Validate settings and repair corrupted data
     */
    validateSettings() {
        const s = this.settings;

        // Objects that must be objects
        if (typeof s.bookmarks !== 'object' || s.bookmarks === null) {
            console.warn('Bookmark Manager: Repaired corrupted bookmarks');
            s.bookmarks = {};
        }
        if (typeof s.groups !== 'object' || s.groups === null) {
            console.warn('Bookmark Manager: Repaired corrupted groups');
            s.groups = {};
        }
        if (typeof s.viewModeSettings !== 'object' || s.viewModeSettings === null) {
            s.viewModeSettings = DEFAULT_SETTINGS.viewModeSettings;
        }

        // Arrays that must be arrays
        if (!Array.isArray(s.groupOrder)) {
            console.warn('Bookmark Manager: Repaired corrupted groupOrder');
            s.groupOrder = [];
        }
        if (!Array.isArray(s.favoriteUrls)) {
            console.warn('Bookmark Manager: Repaired corrupted favoriteUrls');
            s.favoriteUrls = [];
        }
        if (!Array.isArray(s.recentlyAddedUrls)) {
            console.warn('Bookmark Manager: Repaired corrupted recentlyAddedUrls');
            s.recentlyAddedUrls = [];
        }
        if (!Array.isArray(s.ignoredBrokenLinks)) {
            s.ignoredBrokenLinks = [];
        }

        // Validate bookmark entries
        for (const [key, bookmark] of Object.entries(s.bookmarks)) {
            if (!bookmark || typeof bookmark !== 'object' ||
                typeof bookmark.url !== 'string' || typeof bookmark.title !== 'string') {
                console.warn(`Bookmark Manager: Removing invalid bookmark: ${key}`);
                delete s.bookmarks[key];
            } else {
                // Ensure required fields
                if (!Array.isArray(bookmark.tags)) bookmark.tags = [];
                if (!bookmark.id) bookmark.id = this.generateId();
                if (!bookmark.createdAt) bookmark.createdAt = Date.now();
                if (!bookmark.updatedAt) bookmark.updatedAt = bookmark.createdAt;
                // Analytics fields (migration for existing bookmarks)
                if (bookmark.clickCount === undefined) bookmark.clickCount = 0;
                if (bookmark.lastAccessedAt === undefined) bookmark.lastAccessedAt = null;
            }
        }

        // Validate group entries
        for (const [groupName, group] of Object.entries(s.groups)) {
            if (!group || typeof group !== 'object') {
                console.warn(`Bookmark Manager: Removing invalid group: ${groupName}`);
                delete s.groups[groupName];
            } else {
                if (!Array.isArray(group.urls)) group.urls = [];
                // Filter out URLs that don't exist in bookmarks
                group.urls = group.urls.filter(url => s.bookmarks[url]);
                if (!group.createdAt) group.createdAt = Date.now();
                // Migration: ensure parentGroup field exists (null = top-level)
                if (group.parentGroup === undefined) {
                    group.parentGroup = null;
                }
            }
        }

        // Validate parent group references (second pass after all groups are validated)
        for (const [groupName, group] of Object.entries(s.groups)) {
            if (group.parentGroup) {
                // Check if parent exists
                if (!s.groups[group.parentGroup]) {
                    console.warn(`Bookmark Manager: Orphaned sub-group "${groupName}", promoting to top-level`);
                    group.parentGroup = null;
                }
                // Check if parent is itself a sub-group (enforce 1-level depth)
                else if (s.groups[group.parentGroup].parentGroup) {
                    console.warn(`Bookmark Manager: Sub-group "${groupName}" has nested parent, promoting to top-level`);
                    group.parentGroup = null;
                }
            }
        }

        // Clean up groupOrder to only include existing groups
        s.groupOrder = s.groupOrder.filter(name =>
            typeof name === 'string' && Object.prototype.hasOwnProperty.call(s.groups, name)
        );

        // Ensure all groups are in order array
        for (const groupName of Object.keys(s.groups)) {
            if (!s.groupOrder.includes(groupName)) {
                s.groupOrder.push(groupName);
            }
        }

        // Filter out favoriteUrls that don't exist in bookmarks
        s.favoriteUrls = s.favoriteUrls.filter(url => s.bookmarks[url]);

        // Filter out recentlyAddedUrls that don't exist in bookmarks
        s.recentlyAddedUrls = s.recentlyAddedUrls.filter(entry =>
            entry && typeof entry === 'object' && s.bookmarks[entry.url]
        );

        // Validate view mode
        if (typeof s.viewMode !== 'string' || !['grid', 'list', 'compact'].includes(s.viewMode)) {
            s.viewMode = 'grid';
        }

        // Validate numeric settings with bounds
        const numericBounds = {
            cardMinWidth: { min: 100, max: 600, default: 250 },
            cardGap: { min: 0, max: 50, default: 16 },
            cardBorderRadius: { min: 0, max: 30, default: 8 },
            cardPadding: { min: 0, max: 50, default: 16 },
            sectionHeaderSpacing: { min: 0, max: 100, default: 16 },
            recentlyAddedCount: { min: 1, max: 100, default: 10 }
        };

        for (const [key, bounds] of Object.entries(numericBounds)) {
            if (typeof s[key] !== 'number' || isNaN(s[key]) || s[key] < bounds.min || s[key] > bounds.max) {
                s[key] = bounds.default;
            }
        }

        // Validate boolean settings
        const booleanSettings = [
            'showMainHeader', 'showSectionHeaders', 'showBookmarkCounts',
            'showTableOfContents', 'collapsibleSections', 'persistCollapseState',
            'highlightSearchResults', 'stickyControlsBar',
            'enableAnimations', 'enableCardHoverEffects', 'enableCollapseAnimations',
            'enableKeyboardShortcuts', 'enableTags',
            'showFavorites', 'showRecentlyAdded',
            'enableSmartPaste', 'showTagCloud',
            'enableAnalytics', 'enableArchive', 'showArchivedSection',
            // New UI and advanced feature toggles
            'enableBulkSelection', 'showUncategorized', 'showOpenAllButtons',
            'showCollections', 'enableDuplicateDetection', 'enableBrokenLinkDetection'
        ];
        for (const key of booleanSettings) {
            if (typeof s[key] !== 'boolean') {
                s[key] = DEFAULT_SETTINGS[key];
            }
        }

        // Validate objects that must be objects (for completeness)
        if (typeof s.archivedBookmarks !== 'object' || s.archivedBookmarks === null) {
            s.archivedBookmarks = {};
        }
        if (typeof s.tagCollections !== 'object' || s.tagCollections === null) {
            s.tagCollections = {};
        }
        if (typeof s.presets !== 'object' || s.presets === null) {
            s.presets = {};
        }
    }

    /**
     * Generate a unique ID for bookmarks
     */
    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substring(2, 11);
    }

    /**
     * Normalize a URL for consistent comparison
     */
    normalizeUrl(url) {
        try {
            const parsed = new URL(url);
            let normalized = parsed.protocol + '//' + parsed.hostname.toLowerCase();
            if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
                normalized += ':' + parsed.port;
            }
            normalized += (parsed.pathname.replace(/\/$/, '') || '/');
            normalized += parsed.search;
            return normalized;
        } catch {
            return url.toLowerCase().replace(/\/$/, '');
        }
    }

    // ========== BOOKMARK CRUD METHODS ==========

    getBookmark(url) {
        const normalizedUrl = this.normalizeUrl(url);
        return this.settings.bookmarks[normalizedUrl] || null;
    }

    getAllBookmarks() {
        return Object.values(this.settings.bookmarks);
    }

    getGroupBookmarks(groupName) {
        const group = this.settings.groups[groupName];
        if (!group || !Array.isArray(group.urls)) return [];
        return group.urls
            .map(url => this.settings.bookmarks[url])
            .filter(bookmark => {
                if (!bookmark) {
                    console.warn(`Bookmark Manager: Orphaned URL in group "${groupName}" - bookmark no longer exists`);
                    return false;
                }
                return true;
            });
    }

    getFavorites() {
        return this.settings.favoriteUrls
            .map(url => this.settings.bookmarks[url])
            .filter(bookmark => {
                if (!bookmark) {
                    console.warn('Bookmark Manager: Orphaned URL in favorites - bookmark no longer exists');
                    return false;
                }
                return true;
            });
    }

    getRecentlyAdded() {
        const count = this.settings.recentlyAddedCount || 10;
        return this.settings.recentlyAddedUrls
            .slice(0, count)
            .map(entry => {
                const bookmark = this.settings.bookmarks[entry.url];
                if (!bookmark) return null;
                return { ...bookmark, addedAt: entry.addedAt };
            })
            .filter(Boolean);
    }

    async addBookmark(bookmark) {
        const normalizedUrl = this.normalizeUrl(bookmark.url);

        if (this.settings.bookmarks[normalizedUrl]) {
            return false;
        }

        const now = Date.now();
        this.settings.bookmarks[normalizedUrl] = {
            id: this.generateId(),
            title: bookmark.title || 'Untitled',
            url: bookmark.url,
            description: bookmark.description || '',
            tags: Array.isArray(bookmark.tags) ? bookmark.tags : [],
            createdAt: now,
            updatedAt: now,
            clickCount: 0,
            lastAccessedAt: null
        };

        this.settings.recentlyAddedUrls.unshift({
            url: normalizedUrl,
            addedAt: now
        });

        const maxRecent = (this.settings.recentlyAddedCount || 10) * 2;
        if (this.settings.recentlyAddedUrls.length > maxRecent) {
            this.settings.recentlyAddedUrls = this.settings.recentlyAddedUrls.slice(0, maxRecent);
        }

        await this.saveSettings();
        return true;
    }

    async updateBookmark(url, updates) {
        const normalizedUrl = this.normalizeUrl(url);
        const bookmark = this.settings.bookmarks[normalizedUrl];

        if (!bookmark) return false;

        if (updates.url && updates.url !== bookmark.url) {
            const newNormalizedUrl = this.normalizeUrl(updates.url);

            if (this.settings.bookmarks[newNormalizedUrl]) {
                new Notice('A bookmark with that URL already exists');
                return false;
            }

            const favIndex = this.settings.favoriteUrls.indexOf(normalizedUrl);
            if (favIndex !== -1) {
                this.settings.favoriteUrls[favIndex] = newNormalizedUrl;
            }

            for (const group of Object.values(this.settings.groups)) {
                const idx = group.urls.indexOf(normalizedUrl);
                if (idx !== -1) {
                    group.urls[idx] = newNormalizedUrl;
                }
            }

            for (const entry of this.settings.recentlyAddedUrls) {
                if (entry.url === normalizedUrl) {
                    entry.url = newNormalizedUrl;
                }
            }

            delete this.settings.bookmarks[normalizedUrl];
            this.settings.bookmarks[newNormalizedUrl] = {
                ...bookmark,
                url: updates.url,
                updatedAt: Date.now()
            };
        }

        const targetUrl = updates.url ? this.normalizeUrl(updates.url) : normalizedUrl;
        const targetBookmark = this.settings.bookmarks[targetUrl];

        if (updates.title !== undefined) targetBookmark.title = updates.title;
        if (updates.description !== undefined) targetBookmark.description = updates.description;
        if (updates.tags !== undefined) targetBookmark.tags = updates.tags;
        targetBookmark.updatedAt = Date.now();

        await this.saveSettings();
        return true;
    }

    /**
     * Internal sync version of deleteBookmark for batch operations.
     * Does not save settings - caller is responsible for saving.
     * @param {string} url - URL to delete
     * @returns {boolean} Whether the operation was successful
     */
    _deleteBookmarkInternal(url) {
        const normalizedUrl = this.normalizeUrl(url);

        if (!this.settings.bookmarks[normalizedUrl]) return false;

        delete this.settings.bookmarks[normalizedUrl];

        this.settings.favoriteUrls = this.settings.favoriteUrls.filter(u => u !== normalizedUrl);

        for (const group of Object.values(this.settings.groups)) {
            group.urls = group.urls.filter(u => u !== normalizedUrl);
        }

        this.settings.recentlyAddedUrls = this.settings.recentlyAddedUrls.filter(e => e.url !== normalizedUrl);

        return true;
    }

    async deleteBookmark(url) {
        const result = this._deleteBookmarkInternal(url);
        if (!result) return false;
        await this.saveSettings();
        return true;
    }

    // ========== ARCHIVE OPERATIONS ==========

    /**
     * Internal sync version of archiveBookmark for batch operations.
     * Does not save settings - caller is responsible for saving.
     * @param {string} url - URL to archive
     * @returns {boolean} Whether the operation was successful
     */
    _archiveBookmarkInternal(url) {
        if (!this.settings.enableArchive) {
            // If archive is disabled, just delete internally
            return this._deleteBookmarkInternal(url);
        }

        const normalizedUrl = this.normalizeUrl(url);
        const bookmark = this.settings.bookmarks[normalizedUrl];

        if (!bookmark) return false;

        // Store original group memberships for potential restore
        const originalGroups = [];
        for (const [groupName, group] of Object.entries(this.settings.groups)) {
            if (group.urls && group.urls.includes(normalizedUrl)) {
                originalGroups.push(groupName);
                group.urls = group.urls.filter(u => u !== normalizedUrl);
            }
        }

        const wasFavorite = this.settings.favoriteUrls.includes(normalizedUrl);
        if (wasFavorite) {
            this.settings.favoriteUrls = this.settings.favoriteUrls.filter(u => u !== normalizedUrl);
        }

        // Move to archive with metadata
        if (!this.settings.archivedBookmarks) {
            this.settings.archivedBookmarks = {};
        }

        this.settings.archivedBookmarks[normalizedUrl] = {
            ...bookmark,
            archivedAt: Date.now(),
            originalGroups,
            wasFavorite
        };

        delete this.settings.bookmarks[normalizedUrl];
        this.settings.recentlyAddedUrls = this.settings.recentlyAddedUrls.filter(item => item.url !== normalizedUrl);
        return true;
    }

    async archiveBookmark(url) {
        if (!this.settings.enableArchive) {
            // If archive is disabled, just delete
            return this.deleteBookmark(url);
        }

        const normalizedUrl = this.normalizeUrl(url);
        const bookmark = this.settings.bookmarks[normalizedUrl];

        if (!bookmark) return false;

        // Store original group memberships for potential restore
        const originalGroups = [];
        for (const [groupName, group] of Object.entries(this.settings.groups)) {
            if (group.urls?.includes(normalizedUrl)) {
                originalGroups.push(groupName);
            }
        }

        // Move to archive with metadata
        if (!this.settings.archivedBookmarks) {
            this.settings.archivedBookmarks = {};
        }

        this.settings.archivedBookmarks[normalizedUrl] = {
            ...bookmark,
            archivedAt: Date.now(),
            originalGroups,
            wasFavorite: this.settings.favoriteUrls.includes(normalizedUrl)
        };

        // Remove from active bookmarks
        delete this.settings.bookmarks[normalizedUrl];
        this.settings.favoriteUrls = this.settings.favoriteUrls.filter(u => u !== normalizedUrl);
        for (const group of Object.values(this.settings.groups)) {
            group.urls = group.urls.filter(u => u !== normalizedUrl);
        }
        this.settings.recentlyAddedUrls = this.settings.recentlyAddedUrls.filter(e => e.url !== normalizedUrl);

        await this.saveSettings();
        return true;
    }

    async unarchiveBookmark(url, restoreGroups = true) {
        const normalizedUrl = this.normalizeUrl(url);
        const archived = this.settings.archivedBookmarks?.[normalizedUrl];

        if (!archived) return false;

        // Restore to active bookmarks (excluding archive metadata)
        const { archivedAt, originalGroups, wasFavorite, ...bookmarkData } = archived;

        this.settings.bookmarks[normalizedUrl] = {
            ...bookmarkData,
            updatedAt: Date.now()
        };

        // Restore group memberships if requested
        if (restoreGroups && originalGroups) {
            for (const groupName of originalGroups) {
                if (this.settings.groups[groupName]) {
                    if (!this.settings.groups[groupName].urls.includes(normalizedUrl)) {
                        this.settings.groups[groupName].urls.push(normalizedUrl);
                    }
                }
            }
        }

        // Restore favorite status
        if (wasFavorite && !this.settings.favoriteUrls.includes(normalizedUrl)) {
            this.settings.favoriteUrls.push(normalizedUrl);
        }

        // Remove from archive
        delete this.settings.archivedBookmarks[normalizedUrl];

        await this.saveSettings();
        return true;
    }

    async permanentlyDeleteBookmark(url) {
        const normalizedUrl = this.normalizeUrl(url);

        // Remove from archive
        if (this.settings.archivedBookmarks?.[normalizedUrl]) {
            delete this.settings.archivedBookmarks[normalizedUrl];
            await this.saveSettings();
            return true;
        }

        // Also handle case where it's still in active bookmarks
        if (this.settings.bookmarks[normalizedUrl]) {
            return this.deleteBookmark(url);
        }

        return false;
    }

    getArchivedBookmarks() {
        if (!this.settings.archivedBookmarks) return [];

        return Object.values(this.settings.archivedBookmarks)
            .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
    }

    async cleanupOldArchivedBookmarks() {
        const retentionDays = this.settings.archiveRetentionDays;

        // 0 means never auto-delete
        if (!retentionDays || retentionDays <= 0) return 0;

        const threshold = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
        let deletedCount = 0;

        if (this.settings.archivedBookmarks) {
            for (const [url, bookmark] of Object.entries(this.settings.archivedBookmarks)) {
                if (bookmark.archivedAt && bookmark.archivedAt < threshold) {
                    delete this.settings.archivedBookmarks[url];
                    deletedCount++;
                }
            }

            if (deletedCount > 0) {
                await this.saveSettings(false);
            }
        }

        return deletedCount;
    }

    async emptyArchive() {
        if (!this.settings.archivedBookmarks) return 0;

        const count = Object.keys(this.settings.archivedBookmarks).length;
        this.settings.archivedBookmarks = {};

        await this.saveSettings();
        return count;
    }

    // ========== ANALYTICS OPERATIONS ==========

    async trackBookmarkClick(url) {
        if (!this.settings.enableAnalytics) return;

        const normalizedUrl = this.normalizeUrl(url);
        const bookmark = this.settings.bookmarks[normalizedUrl];

        if (!bookmark) return;

        bookmark.clickCount = (bookmark.clickCount || 0) + 1;
        bookmark.lastAccessedAt = Date.now();

        // Save without refreshing views (don't want to interrupt user)
        await this.saveSettings(false);
    }

    getMostUsedBookmarks(limit = 10) {
        const bookmarks = Object.values(this.settings.bookmarks);
        return bookmarks
            .filter(b => b.clickCount > 0)
            .sort((a, b) => b.clickCount - a.clickCount)
            .slice(0, limit);
    }

    getDormantBookmarks(days = 30) {
        const threshold = Date.now() - (days * 24 * 60 * 60 * 1000);
        const bookmarks = Object.values(this.settings.bookmarks);
        return bookmarks.filter(b => {
            // Never accessed or accessed before threshold
            return !b.lastAccessedAt || b.lastAccessedAt < threshold;
        });
    }

    getAnalyticsSummary() {
        const bookmarks = Object.values(this.settings.bookmarks);
        const totalClicks = bookmarks.reduce((sum, b) => sum + (b.clickCount || 0), 0);
        const activeBookmarks = bookmarks.filter(b => b.clickCount > 0).length;
        const neverClicked = bookmarks.filter(b => !b.clickCount || b.clickCount === 0).length;
        const dormantDays = this.settings.dormantDaysThreshold || 30;
        const dormantCount = this.getDormantBookmarks(dormantDays).length;

        return {
            totalBookmarks: bookmarks.length,
            totalClicks,
            activeBookmarks,
            neverClicked,
            dormantCount,
            dormantDays
        };
    }

    async resetAnalytics() {
        for (const bookmark of Object.values(this.settings.bookmarks)) {
            bookmark.clickCount = 0;
            bookmark.lastAccessedAt = null;
        }
        await this.saveSettings(true);
    }

    // ========== FAVORITES OPERATIONS ==========

    /**
     * Internal sync version of addToFavorites for batch operations.
     * Does not save settings - caller is responsible for saving.
     * @param {string} url - URL to add to favorites
     * @returns {boolean} Whether the operation was successful
     */
    _addToFavoritesInternal(url) {
        const normalizedUrl = this.normalizeUrl(url);

        if (!this.settings.bookmarks[normalizedUrl]) return false;
        if (this.settings.favoriteUrls.includes(normalizedUrl)) return false;

        this.settings.favoriteUrls.push(normalizedUrl);
        return true;
    }

    async addToFavorites(url) {
        const result = this._addToFavoritesInternal(url);
        if (!result) return false;
        await this.saveSettings();
        return true;
    }

    async removeFromFavorites(url) {
        const normalizedUrl = this.normalizeUrl(url);
        const index = this.settings.favoriteUrls.indexOf(normalizedUrl);

        if (index === -1) return false;

        this.settings.favoriteUrls.splice(index, 1);
        await this.saveSettings();
        return true;
    }

    isFavorite(url) {
        const normalizedUrl = this.normalizeUrl(url);
        return this.settings.favoriteUrls.includes(normalizedUrl);
    }

    // ========== GROUP OPERATIONS ==========

    async createGroup(name, options = {}) {
        if (this.settings.groups[name]) return false;

        const parentGroup = options.parentGroup || null;

        // Validate parent if specified
        if (parentGroup) {
            // Parent must exist
            if (!this.settings.groups[parentGroup]) return false;
            // Parent must be top-level (no nested sub-groups allowed)
            if (this.settings.groups[parentGroup].parentGroup) return false;
        }

        this.settings.groups[name] = {
            urls: [],
            icon: options.icon || '📁',
            color: options.color || '',
            createdAt: Date.now(),
            parentGroup: parentGroup
        };

        // Insert at correct position in groupOrder
        if (parentGroup) {
            // Find position after parent and its existing children
            let insertIdx = this.settings.groupOrder.indexOf(parentGroup) + 1;
            for (let i = insertIdx; i < this.settings.groupOrder.length; i++) {
                const g = this.settings.groups[this.settings.groupOrder[i]];
                if (g?.parentGroup === parentGroup) {
                    insertIdx = i + 1;
                } else {
                    break;
                }
            }
            this.settings.groupOrder.splice(insertIdx, 0, name);
        } else {
            this.settings.groupOrder.push(name);
        }

        await this.saveSettings();
        return true;
    }

    async deleteGroup(name, options = { promoteChildren: true }) {
        if (!this.settings.groups[name]) return false;

        const group = this.settings.groups[name];
        const isParent = !group.parentGroup;

        if (isParent) {
            // Handle children when deleting a parent group
            const children = this.getSubGroups(name);
            if (options.promoteChildren) {
                // Promote children to top-level
                for (const childName of children) {
                    this.settings.groups[childName].parentGroup = null;
                }
            } else {
                // Cascade delete children
                for (const childName of children) {
                    delete this.settings.groups[childName];
                    this.settings.groupOrder = this.settings.groupOrder.filter(n => n !== childName);
                }
            }
        }

        delete this.settings.groups[name];
        this.settings.groupOrder = this.settings.groupOrder.filter(n => n !== name);

        await this.saveSettings();
        return true;
    }

    async renameGroup(oldName, newName) {
        if (!this.settings.groups[oldName]) return false;
        if (this.settings.groups[newName]) return false;

        this.settings.groups[newName] = this.settings.groups[oldName];
        delete this.settings.groups[oldName];

        const index = this.settings.groupOrder.indexOf(oldName);
        if (index !== -1) {
            this.settings.groupOrder[index] = newName;
        }

        // Update any children's parentGroup reference
        for (const [groupName, group] of Object.entries(this.settings.groups)) {
            if (group.parentGroup === oldName) {
                group.parentGroup = newName;
            }
        }

        await this.saveSettings();
        return true;
    }

    async updateGroup(name, updates) {
        const group = this.settings.groups[name];
        if (!group) return false;

        if (updates.icon !== undefined) group.icon = updates.icon;
        if (updates.color !== undefined) group.color = updates.color;

        await this.saveSettings();
        return true;
    }

    /**
     * Internal sync version of addToGroup for batch operations.
     * Does not save settings - caller is responsible for saving.
     * @param {string} url - URL to add to group
     * @param {string} groupName - Name of the group
     * @returns {boolean} Whether the operation was successful
     */
    _addToGroupInternal(url, groupName) {
        const normalizedUrl = this.normalizeUrl(url);

        if (!this.settings.bookmarks[normalizedUrl]) return false;
        if (!this.settings.groups[groupName]) return false;
        if (this.settings.groups[groupName].urls.includes(normalizedUrl)) return false;

        this.settings.groups[groupName].urls.push(normalizedUrl);
        return true;
    }

    async addToGroup(url, groupName) {
        const result = this._addToGroupInternal(url, groupName);
        if (!result) return false;
        await this.saveSettings();
        return true;
    }

    async removeFromGroup(url, groupName) {
        const normalizedUrl = this.normalizeUrl(url);
        const group = this.settings.groups[groupName];

        if (!group) return false;

        const index = group.urls.indexOf(normalizedUrl);
        if (index === -1) return false;

        group.urls.splice(index, 1);
        await this.saveSettings();
        return true;
    }

    getBookmarkGroups(url) {
        const normalizedUrl = this.normalizeUrl(url);
        const groups = [];
        for (const [groupName, group] of Object.entries(this.settings.groups)) {
            if (group.urls && group.urls.includes(normalizedUrl)) {
                groups.push(groupName);
            }
        }
        return groups;
    }

    async moveGroup(name, newIndex) {
        const currentIndex = this.settings.groupOrder.indexOf(name);
        if (currentIndex === -1) return;

        this.settings.groupOrder.splice(currentIndex, 1);
        this.settings.groupOrder.splice(newIndex, 0, name);

        await this.saveSettings();
    }

    // ========== SUB-GROUP HELPERS ==========

    /**
     * Check if a group is a top-level (parent) group
     * @param {string} groupName - Name of the group
     * @returns {boolean}
     */
    isTopLevelGroup(groupName) {
        const group = this.settings.groups[groupName];
        return group && !group.parentGroup;
    }

    /**
     * Check if a group is a sub-group
     * @param {string} groupName - Name of the group
     * @returns {boolean}
     */
    isSubGroup(groupName) {
        const group = this.settings.groups[groupName];
        return group && !!group.parentGroup;
    }

    /**
     * Get all sub-groups of a parent group
     * @param {string} parentName - Name of the parent group
     * @returns {string[]} Array of child group names
     */
    getSubGroups(parentName) {
        return Object.entries(this.settings.groups)
            .filter(([_, group]) => group.parentGroup === parentName)
            .map(([name, _]) => name);
    }

    /**
     * Get the parent of a sub-group
     * @param {string} groupName - Name of the group
     * @returns {string|null} Parent name or null if top-level
     */
    getParentGroup(groupName) {
        const group = this.settings.groups[groupName];
        return group?.parentGroup || null;
    }

    /**
     * Get groups in hierarchical order for display
     * Returns top-level groups with their sub-groups immediately after
     * @returns {Array<{name: string, isSubGroup: boolean, parent: string|null, depth: number}>}
     */
    getHierarchicalGroupOrder() {
        const result = [];
        const processed = new Set();

        for (const name of this.settings.groupOrder) {
            if (processed.has(name)) continue;

            const group = this.settings.groups[name];
            if (!group) continue;

            // Skip sub-groups in first pass (they'll be added under their parent)
            if (group.parentGroup) continue;

            // Add parent group
            result.push({ name, isSubGroup: false, parent: null, depth: 0 });
            processed.add(name);

            // Add its children in order
            for (const childName of this.settings.groupOrder) {
                if (processed.has(childName)) continue;
                const child = this.settings.groups[childName];
                if (child?.parentGroup === name) {
                    result.push({ name: childName, isSubGroup: true, parent: name, depth: 1 });
                    processed.add(childName);
                }
            }
        }

        return result;
    }

    /**
     * Set or change the parent group of a group
     * @param {string} groupName - Name of the group to modify
     * @param {string|null} newParentName - New parent name, or null to make top-level
     * @returns {Promise<boolean>}
     */
    async setParentGroup(groupName, newParentName) {
        const group = this.settings.groups[groupName];
        if (!group) return false;

        // Cannot make a parent group (that has children) into a sub-group
        if (this.getSubGroups(groupName).length > 0) {
            return false;
        }

        if (newParentName) {
            // Validate new parent exists and is top-level
            if (!this.settings.groups[newParentName]) return false;
            if (this.settings.groups[newParentName].parentGroup) return false;
            // Cannot be its own parent
            if (groupName === newParentName) return false;
        }

        // Remove from current position in groupOrder
        this.settings.groupOrder = this.settings.groupOrder.filter(n => n !== groupName);

        // Update parent reference
        group.parentGroup = newParentName || null;

        // Insert at correct position
        if (newParentName) {
            // Find position after parent and its existing children
            let insertIdx = this.settings.groupOrder.indexOf(newParentName) + 1;
            for (let i = insertIdx; i < this.settings.groupOrder.length; i++) {
                const g = this.settings.groups[this.settings.groupOrder[i]];
                if (g?.parentGroup === newParentName) {
                    insertIdx = i + 1;
                } else {
                    break;
                }
            }
            this.settings.groupOrder.splice(insertIdx, 0, groupName);
        } else {
            // Add to end as top-level
            this.settings.groupOrder.push(groupName);
        }

        await this.saveSettings();
        return true;
    }

    /**
     * Save settings to disk and refresh views
     * @param {boolean} immediateRefresh - Whether to refresh views immediately (default: true)
     */
    async saveSettings(immediateRefresh = true) {
        if (this._savingSettings) {
            this._pendingSave = { immediateRefresh: immediateRefresh || this._pendingSave?.immediateRefresh };
            return;
        }

        this._savingSettings = true;
        try {
            await this.saveData({
                ...this.settings,
                _collapsedState: this.collapsedState || []
            });

            if (this._pendingSave) {
                const pendingRefresh = this._pendingSave.immediateRefresh;
                this._pendingSave = null;
                this._savingSettings = false;
                return this.saveSettings(pendingRefresh);
            }

            if (immediateRefresh) {
                this.refreshViews();
            }
        } finally {
            this._savingSettings = false;
        }
    }

    refreshViews() {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_BOOKMARK_HOMEPAGE);
        for (const leaf of leaves) {
            const view = leaf.view;
            if (view instanceof FrontpageView) {
                view.render();
            }
        }
    }

    async activateView() {
        const { workspace } = this.app;

        let leaf = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_BOOKMARK_HOMEPAGE);

        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getLeaf('tab');
            await leaf.setViewState({ type: VIEW_TYPE_BOOKMARK_HOMEPAGE, active: true });
        }

        workspace.revealLeaf(leaf);
    }

    async checkAllLinks() {
        // Filter out ignored links upfront
        const allBookmarks = this.getAllBookmarks().filter(
            bookmark => !this.settings.ignoredBrokenLinks?.includes(bookmark.url)
        );

        if (allBookmarks.length === 0) {
            new Notice('No bookmarks to check');
            return;
        }

        // Create a persistent notice for progress updates
        const notice = new Notice(`Checking 0/${allBookmarks.length} links...`, 0);
        const brokenLinks = [];
        const batchSize = CONFIG.LINK_CHECK_BATCH_SIZE;
        let checked = 0;

        // Process in batches to avoid blocking UI and overwhelming network
        for (let i = 0; i < allBookmarks.length; i += batchSize) {
            const batch = allBookmarks.slice(i, i + batchSize);

            // Check batch concurrently
            const results = await Promise.all(
                batch.map(async (bookmark) => {
                    const result = await this.checkLink(bookmark.url);
                    return result.ok ? null : { ...bookmark, error: result.error };
                })
            );

            // Collect broken links from this batch
            for (const result of results) {
                if (result) brokenLinks.push(result);
            }

            // Update progress
            checked = Math.min(i + batchSize, allBookmarks.length);
            notice.setMessage(`Checking ${checked}/${allBookmarks.length} links... (${brokenLinks.length} broken)`);
        }

        // Hide progress notice and show results
        notice.hide();
        new BrokenLinksModal(this.app, this, brokenLinks).open();
    }

    async checkLink(url) {
        try {
            // Use Obsidian's requestUrl to bypass CORS and get actual status
            const response = await requestUrl({
                url: url,
                method: 'HEAD',
                timeout: CONFIG.LINK_CHECK_TIMEOUT_MS
            });

            // Check for successful status codes (2xx)
            if (response.status >= 200 && response.status < 300) {
                return { ok: true };
            }
            return { ok: false, error: `HTTP ${response.status}` };
        } catch (error) {
            return { ok: false, error: error.message || 'Failed to fetch' };
        }
    }

    /**
     * Extract metadata (title, description) from a URL
     * @param {string} url - The URL to fetch metadata from
     * @returns {Promise<{title: string, description: string, success: boolean}>}
     */
    async extractMetadataFromUrl(url) {
        try {
            // Use Obsidian's requestUrl to bypass CORS restrictions
            const response = await requestUrl({
                url: url,
                method: 'GET',
                headers: {
                    'Accept': 'text/html'
                },
                timeout: CONFIG.LINK_CHECK_TIMEOUT_MS
            });

            if (response.status < 200 || response.status >= 300) {
                return { title: '', description: '', success: false };
            }

            const html = response.text;
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            // Try to get title from Open Graph, then fall back to <title> tag
            let title = '';
            const ogTitle = doc.querySelector('meta[property="og:title"]');
            if (ogTitle) {
                title = ogTitle.getAttribute('content') || '';
            }
            if (!title) {
                const titleEl = doc.querySelector('title');
                title = titleEl ? titleEl.textContent.trim() : '';
            }

            // Try to get description from Open Graph, then meta description
            let description = '';
            const ogDesc = doc.querySelector('meta[property="og:description"]');
            if (ogDesc) {
                description = ogDesc.getAttribute('content') || '';
            }
            if (!description) {
                const metaDesc = doc.querySelector('meta[name="description"]');
                description = metaDesc ? metaDesc.getAttribute('content') || '' : '';
            }

            return { title, description, success: true };
        } catch (error) {
            // Network errors are expected for some sites
            // Return empty but indicate we tried
            return { title: '', description: '', success: false };
        }
    }

    // ========== TAG OPERATIONS ==========

    /**
     * Get all unique tags with their bookmark counts
     * @returns {Map<string, number>} Map of tag names to counts
     */
    getAllTags() {
        const tagCounts = new Map();
        for (const bookmark of Object.values(this.settings.bookmarks)) {
            if (Array.isArray(bookmark.tags)) {
                for (const tag of bookmark.tags) {
                    tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
                }
            }
        }
        return tagCounts;
    }

    /**
     * Get bookmarks matching the given tags
     * @param {string[]} tags - Tags to filter by
     * @param {string} mode - 'AND' (all tags) or 'OR' (any tag)
     * @returns {Object[]} Array of matching bookmarks
     */
    getBookmarksByTags(tags, mode = 'AND') {
        if (!tags || tags.length === 0) {
            return Object.values(this.settings.bookmarks);
        }

        const normalizedTags = tags.map(t => t.toLowerCase());

        return Object.values(this.settings.bookmarks).filter(bookmark => {
            if (!Array.isArray(bookmark.tags) || bookmark.tags.length === 0) {
                return false;
            }
            const bookmarkTags = bookmark.tags.map(t => t.toLowerCase());

            if (mode === 'AND') {
                return normalizedTags.every(tag => bookmarkTags.includes(tag));
            } else {
                return normalizedTags.some(tag => bookmarkTags.includes(tag));
            }
        });
    }

    /**
     * Merge one tag into another across all bookmarks
     * @param {string} oldTag - Tag to replace
     * @param {string} newTag - Tag to replace with
     */
    async mergeTag(oldTag, newTag) {
        let updated = false;
        for (const bookmark of Object.values(this.settings.bookmarks)) {
            if (Array.isArray(bookmark.tags)) {
                const index = bookmark.tags.indexOf(oldTag);
                if (index !== -1) {
                    // Remove old tag
                    bookmark.tags.splice(index, 1);
                    // Add new tag if not already present
                    if (!bookmark.tags.includes(newTag)) {
                        bookmark.tags.push(newTag);
                    }
                    updated = true;
                }
            }
        }
        if (updated) {
            await this.saveSettings();
        }
        return updated;
    }

    /**
     * Delete a tag from all bookmarks
     * @param {string} tag - Tag to delete
     */
    async deleteTag(tag) {
        let updated = false;
        for (const bookmark of Object.values(this.settings.bookmarks)) {
            if (Array.isArray(bookmark.tags)) {
                const index = bookmark.tags.indexOf(tag);
                if (index !== -1) {
                    bookmark.tags.splice(index, 1);
                    updated = true;
                }
            }
        }
        if (updated) {
            await this.saveSettings();
        }
        return updated;
    }

    // ========== COLLECTION OPERATIONS ==========

    /**
     * Save a tag collection
     * @param {string} name - Collection name
     * @param {string[]} tags - Tags in the collection
     */
    async saveCollection(name, tags) {
        this.settings.tagCollections[name] = tags;
        await this.saveSettings();
    }

    /**
     * Delete a tag collection
     * @param {string} name - Collection name to delete
     */
    async deleteCollection(name) {
        delete this.settings.tagCollections[name];
        await this.saveSettings();
    }

    /**
     * Rename a tag collection
     * @param {string} oldName - Current collection name
     * @param {string} newName - New collection name
     */
    async renameCollection(oldName, newName) {
        if (this.settings.tagCollections[oldName]) {
            this.settings.tagCollections[newName] = this.settings.tagCollections[oldName];
            delete this.settings.tagCollections[oldName];
            await this.saveSettings();
        }
    }

    async findDuplicates() {
        const allBookmarks = this.getAllBookmarks();

        if (allBookmarks.length === 0) {
            new Notice('No bookmarks to check');
            return;
        }

        const urlMap = new Map();

        for (const bookmark of allBookmarks) {
            const normalizedUrl = this.normalizeUrl(bookmark.url);
            if (!urlMap.has(normalizedUrl)) {
                urlMap.set(normalizedUrl, []);
            }
            urlMap.get(normalizedUrl).push(bookmark);
        }

        const duplicates = [];
        for (const [url, bookmarks] of urlMap) {
            if (bookmarks.length > 1) {
                duplicates.push({ url, bookmarks });
            }
        }

        new DuplicatesModal(this.app, this, duplicates).open();
    }
};
