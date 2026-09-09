# Responsive scroll QA

Regression coverage for two confirmed production bugs plus scroll/overflow guards.

## What it checks

1. Narrow viewport (390px): mouse-wheel over the conversation scrolls the page
   (guards the `overscroll-behavior` trap fixed in `ChatInterface.jsx`).
2. Tools panel closes on Escape (guards the missing key handler in `ToolsPanel.jsx`).
3. No page-level horizontal overflow at 390px.
4. Bottom reachable + composer visible.
5. Drawer opens and closes.
6. Desktop wheel scrolls the internal conversation area, not the page.

## Run

```bash
pip install playwright
python -m playwright install chromium   # or set ARC_CHROMIUM_PATH to a system build
npm run dev -- --port 5199               # from client/, separate terminal
python client/tests/qa/test_responsive_scroll.py
```
