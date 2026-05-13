# Contributing

Contributions are welcome. Open an issue to discuss what you'd like to change before submitting a PR.

## Development setup

Prerequisites: [Node.js](https://nodejs.org/) (v20+), [Rust](https://rustup.rs/), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```sh
git clone https://github.com/danifuldan/budget-itemizer.git
cd budget-itemizer
npm install
cp .env.example .env
```

The app runs as two processes in development — start them in separate terminals:

```sh
# Terminal 1: backend (Node.js, port 3456)
npm run dev

# Terminal 2: frontend + Tauri shell
npm run tauri:dev
```

Run tests with `npm test`.
