# Bookmark Homepage

An Obsidian plugin that creates a visual dashboard for your bookmarks, displaying them as an organized card grid with powerful search, filtering, and customization options.

## Features

### Core Features
- **Multiple view modes**: Grid, List, or Compact layouts with per-mode settings
- **Responsive card grid**: Auto-adjusts to screen size
- **Custom groups**: Create bookmark collections with custom icons and colors
- **Favorites**: Pin frequently used bookmarks to a dedicated section
- **Recently Added**: Track newly added bookmarks
- **Table of Contents**: Sticky sidebar for quick navigation
- **Search**: Filter bookmarks with highlighted results
- **Collapsible sections**: Collapse/expand groups and sections
- **Favicons**: Display site icons with configurable sizes
- **Tags**: Categorize and filter bookmarks by tags
- **Keyboard shortcuts**: Ctrl/Cmd+F to focus search, Escape to clear

### Smart Paste
Quickly add bookmarks by copying a URL and using Smart Paste:
- Automatically extracts page title and description from Open Graph/meta tags
- Opens Add Bookmark modal pre-filled with extracted metadata
- Detects and warns about duplicate URLs
- Optional default group assignment for pasted bookmarks

### Tag Collections
Save and quickly apply tag filter combinations:
- Save unlimited collections with custom names
- One-click filtering by saved tag combinations
- Tag cloud display with counts
- AND/OR filter modes for multi-tag filtering
- Tag management: merge or delete tags across all bookmarks

### Usage Analytics
Track how you use your bookmarks:
- Click counts and last accessed times
- Most Used bookmarks list (configurable 5-25 items)
- Dormant bookmarks detection (configurable 7-90 day threshold)
- Analytics dashboard with summary statistics
- Reset analytics data when needed

### Bulk Selection Mode
Select multiple bookmarks for batch operations:
- Add to Favorites (bulk)
- Add to Group (bulk)
- Archive selected bookmarks
- Delete selected bookmarks
- Select All / Deselect All controls

### Archive System
Soft-delete bookmarks with recovery option:
- Archive preserves bookmark data and original group memberships
- Restore bookmarks to all original groups
- Permanent delete option for archived items
- Auto-delete after configurable retention period (0-90 days)
- Archive section on dashboard (can be hidden)
- Empty archive with confirmation

### Cleanup Assistant
Multi-step wizard to manage unused bookmarks:
1. **Overview**: Statistics showing total, never-clicked, dormant, and active bookmarks
2. **Never-clicked**: Review and select bookmarks never accessed
3. **Dormant**: Review bookmarks not used within threshold (adjustable 7-90 days)
4. **Action**: Choose to Archive, Delete, or Keep selected bookmarks
5. **Summary**: Results showing what was processed

### Export/Import
Backup and restore your bookmark data:

**Export options:**
- Bookmarks with full metadata
- Groups and group ordering
- Favorites list
- Analytics data (click counts, access times)
- Archived bookmarks
- Tag collections
- Custom layout presets
- Display settings

**Import options:**
- Merge mode: Add new items, skip existing
- Replace mode: Overwrite all existing data
- Selective import: Choose which data types to import
- Validation ensures file compatibility

### Settings Presets
Save and restore layout configurations:
- Save current view mode settings as named presets
- Quick-switch between presets
- Manage (rename/delete) saved presets

## Platform Support

This plugin is **desktop-only** and requires Obsidian desktop app. Mobile devices are not currently supported due to context menu and hover interaction dependencies.

## Screenshots

<!-- Add screenshots of your plugin here -->
*Screenshots coming soon - showing the bookmark dashboard, settings panel, and various features.*

## Installation

### From Community Plugins (Recommended)

1. Open Obsidian Settings
2. Go to **Community Plugins** and disable Safe Mode if prompted
3. Click **Browse** and search for "Bookmark Manager"
4. Click **Install**, then **Enable**

### Manual Installation

1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](https://github.com/Real-Fruit-Snacks/bookmark-manager/releases/latest)
2. Create a folder called `bookmark-manager` in your vault's `.obsidian/plugins/` directory
3. Copy the downloaded files into the new folder
4. Restart Obsidian and enable the plugin in Settings > Community Plugins

## Usage

### Adding Bookmarks
- **Quick Add**: Click the + button or use Command Palette > "Add Bookmark"
- **Smart Paste**: Copy a URL, then click the clipboard button to auto-fill from page metadata
- **Import**: Import from browser HTML exports via Command Palette > "Import Bookmarks from Browser"

### Organizing Bookmarks
- **Groups**: Right-click a bookmark > "Add to Group" or create new groups
- **Favorites**: Right-click > "Add to Favorites" or use the star icon
- **Tags**: Add tags when creating/editing bookmarks, then filter via tag cloud

### Context Menu
Right-click any bookmark card to:
- Copy URL / Copy as Markdown link
- Check Link (verify if URL is accessible)
- Edit Bookmark
- Add to / Remove from Favorites
- Add to custom groups
- Archive Bookmark

Right-click section headers for bulk actions:
- Open All Bookmarks
- Copy All URLs
- Collapse/Expand Section
- Change Icon or Color (for custom groups)

## Commands

Access these commands via the Command Palette (Ctrl/Cmd+P):

- **Open Bookmark Homepage**: Open the bookmark dashboard view
- **Add Bookmark**: Quick-add a new bookmark via dialog
- **Check for Broken Links**: Scan all bookmarks for dead links
- **Import Bookmarks from Browser**: Import bookmarks from browser HTML exports
- **Find Duplicate Bookmarks**: Detect and review duplicate URLs

## Settings

### View Mode Settings
Per-mode (Grid/List/Compact) configuration:
- Card minimum width, gap, padding, border radius
- Favicon display and size
- Show/hide URLs, descriptions, tags

### Headers
- Dashboard title customization
- Show/hide main header and section headers
- Bookmark counts per section
- Section header spacing

### Navigation
- Table of contents visibility
- Collapsible sections toggle
- Persist collapse state between sessions
- Sticky controls bar

### Features
- Keyboard shortcuts toggle
- Tag display and colors
- Search result highlighting
- Animation and hover effects

### Special Sections
- Favorites section visibility
- Recently Added section with count limit
- Tag cloud display
- Tag filter mode (AND/OR)

### Analytics
- Enable/disable usage tracking
- Most used list size (5-25)
- Dormant threshold (7-90 days)
- View insights dashboard
- Reset analytics data

### Archive
- Enable/disable archive system
- Show/hide archive section
- Auto-delete retention period (0-90 days)
- Empty archive

### Data Management
- Export data to JSON file
- Import data from JSON file

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

If you find this plugin useful, consider starring the repository on GitHub.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
