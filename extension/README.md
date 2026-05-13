# Budget Itemizer — Chrome Extension

Companion browser extension for the Budget Itemizer desktop app. Captures any page as a PDF and sends it to the desktop app for receipt parsing.

## How It Works

1. Click the extension icon on any receipt or order page
2. The extension prints the page to PDF (via Chrome DevTools Protocol)
3. Sends the PDF to your running Budget Itemizer desktop app
4. Shows streaming parse progress as items are extracted
5. Open the desktop app to review and import to YNAB

## Loading (Development)

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select this `extension/` directory
5. The Budget Itemizer icon appears in your toolbar

## Requirements

- Budget Itemizer desktop app must be running (default port: 3456)
- Chrome, Edge, or Brave (Manifest V3 + debugger API)
- Click the gear icon in the popup to change the port if needed

## Permissions

- **activeTab** — access the current tab when you click the icon
- **debugger** — needed for `Page.printToPDF` (shows a brief "debugging" banner)
- **storage** — saves your port setting and auth credentials locally
- **localhost access** — communicates with the desktop app

## Notes

- The "started debugging this browser" bar appears briefly during capture — this is normal
- The extension only captures when you click it — no background monitoring
- All processing happens locally on your machine via the desktop app
