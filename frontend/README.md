# Unreal Editor WebUI Frontend

React/Vite frontend for the Unreal Editor WebUI plugin.

## Development

Use Node.js 22.13 or newer, or Node.js 20.19 or newer.

```sh
npm ci
npm run dev
```

Configure the plugin to load `http://localhost:5173` through the Web UI startup settings.

## Build

```sh
npm run build
```

The production build is emitted to `../Web/dist`, which the plugin loads before falling back to `Web/index.html`.

## Test

```sh
npm test
```

Vitest covers schema value coercion, falsy result rendering, and resilient task restoration behavior.

## Bridge

When loaded inside Unreal, the bridge is available at:

```ts
window.ue.editorwebui
```

The app should gracefully handle the bridge being unavailable when running in a normal browser.
