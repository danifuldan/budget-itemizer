# Budget Itemizer

**Split and categorize your online receipts in YNAB — free, local, and private.**

## What it is

YNAB is great for budgeting, but it doesn't help you understand how your money gets spent within a big purchase. You might buy shampoo, rotisserie chicken, batteries, and a blanket in the same order — how do you categorize that transaction? YNAB does provide transaction splitting, but it's slow, manual work. Commercial solutions for receipt import exist, but they require paying more money on top of your existing YNAB subscription and giving one more company your data.

Budget Itemizer takes your online order receipt — tested with Amazon, Walmart, Costco, and a few others so far — and separates the transaction into its line items. Then it uploads the split transaction back to YNAB. The app downloads an AI model during initial setup; the processing itself runs locally on your machine.

Drop a PDF into the inbox folder or drag it into the app window, and watch it go to work.

### How it works

1. **Drop a receipt** — Drag a PDF into the app or save it to the inbox folder.
2. **Review the split** — The AI parses line items and maps them to your YNAB categories. Edit anything it got wrong.
3. **Import to YNAB** — One click and the split transaction lands in your budget.

## Architecture

Budget Itemizer is a Tauri desktop app — a Rust shell wrapping a React frontend, with a Node.js backend running as a sidecar process. The local-first promise drove every architectural choice. Tauri over Electron keeps the binary small. The Node sidecar handles PDF extraction, LLM orchestration, and YNAB API calls. A bundled `llama-server` instance runs the AI model on your hardware — no cloud endpoint, no API key, no network request. See [Architecture](docs/architecture.md) for the full technical breakdown.

## Install

Requires macOS on Apple Silicon (M1 or later).

1. [Download Budget Itemizer.dmg](https://github.com/danifuldan/budget-itemizer/releases/latest) and drag the app to Applications.
2. Open Budget Itemizer. On first launch, the setup wizard walks you through connecting your YNAB account and downloading the AI model (~4.9GB).
3. Drop a receipt and watch it go.

<details>
<summary>macOS says the app "can't be opened" — here's how to fix it</summary>

Budget Itemizer isn't signed with an Apple Developer certificate, so macOS blocks it by default. This is a standard Gatekeeper warning for open-source apps distributed outside the App Store. [More from Apple](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac).

**Option A — System Settings (recommended)**
1. Try to open the app. macOS will show a warning.
2. Go to **System Settings → Privacy & Security**.
3. Scroll to the Security section — you'll see "Budget Itemizer was blocked." Click **Open Anyway**.

**Option B — Terminal**
```sh
xattr -cr "/Applications/Budget Itemizer.app"
```
Then open the app normally.
</details>

## FAQ

### Privacy & data

#### Where does my data go?

Your data goes to *your* YNAB account (or *your* Actual Budget server), from *your* computer. That's it. Budget Itemizer is not a cloud service — there's no server we run, no account you create with us, no telemetry, and no analytics. The receipt parsing happens locally on your machine via a bundled language model. The only network requests are the YNAB or Actual Budget API calls you'd make anyway, plus the one-time model download from Hugging Face during setup. The code is open — you can read it and verify.

#### Does my data go to OpenAI, Anthropic, or any other AI company?

No. The receipt parsing uses [Llama 3.1 8B](https://www.llama.com/) by Meta, running entirely on your Mac. No prompts, receipts, or transaction details are sent to any AI provider. This is the whole point: small open models running locally are more than capable of this kind of structured extraction work, and they don't require trusting a third party with your data.

#### Why isn't the app signed or notarized?

Budget Itemizer is in public beta. Apple Developer Program membership costs $99/year and I am keeping costs at zero until there's signal that people want this. Once it's clear the project has legs, signing is the next step. Until then, see the Gatekeeper bypass instructions above — it's a one-time click, not a recurring annoyance.

### How it works

#### What receipts work?

Tested formats: order invoices from Amazon, Walmart, Costco, Kroger, and Target. These are typically downloaded as PDFs from your order history. Register tape photos, scanned paper receipts, and email-only receipts are *not* the target — Budget Itemizer is built for the structured PDFs you can export from your online order history. Other retailers may work (your mileage will vary); please open an issue with a sample if you find one that doesn't parse correctly.

#### Why is the model so big?

Llama 3.1 8B is ~4.9 GB. It's downloaded once, lives in `~/.config/budget-itemizer/models/`, and runs entirely on your Mac. You can delete it any time from Settings → Models → Delete. The size is the cost of running a capable model locally — and it's the reason your data doesn't have to leave your machine.

#### Why Apple Silicon only?

Budget Itemizer relies on Apple Silicon's unified memory and GPU acceleration to run Llama 3.1 8B at usable speed. On Intel Macs, the same model would be unusably slow. Expanding hardware support is possible later but isn't a priority for this beta.

#### Does it work offline?

Yes — once setup is complete and the model is downloaded, receipt parsing works without an internet connection. The only thing that requires internet is syncing your splits to YNAB or Actual Budget, since those are remote services.

### Known issues

#### What's broken or wonky right now?

- Receipt format coverage is narrow (Amazon / Walmart / Costco order invoices). Other retailers may misparse.
- Apple Foundation Models (iOS 18+ on-device LLM) is implemented but disabled because Apple's content filtering blocks legitimate receipt content (book titles, etc.). Stick with the bundled Llama provider.

#### How do I report a bug or request a feature?

Open an issue at [github.com/danifuldan/budget-itemizer/issues](https://github.com/danifuldan/budget-itemizer/issues). Include the receipt PDF if relevant, what you expected, what happened, and any errors from the app's status bar or logs (Settings → "Reveal app logs in Finder").

### Credentials

#### Is it safe to paste my YNAB API token here?

Yes. Budget Itemizer stores your token in the **macOS Keychain** — the same place Safari stores your saved passwords — and only sends it to YNAB itself. Nothing is sent anywhere else. You can revoke the token at any time from YNAB's settings.

#### How do I get a YNAB API token?

In YNAB, go to **Account Settings → Developer Settings → New Token**. Copy the generated token and paste it into Budget Itemizer's setup wizard. Direct link: [app.ynab.com/settings/developer](https://app.ynab.com/settings/developer).

#### What does Budget Itemizer do with my token?

It uses the token to read your budget categories and accounts (so it can predict the right category for each line item) and to create split transactions in YNAB. Nothing else.

#### Can I revoke the token later?

Yes. Go to **Account Settings → Developer Settings** in YNAB and delete the token. Budget Itemizer will stop working until you generate a new one.

#### Why does Budget Itemizer need my Actual Budget password?

Actual's API authenticates with your server password — unlike YNAB, Actual doesn't issue separate API tokens. The same password you use to log in to your Actual server is what Budget Itemizer needs to read your budget and create transactions. **This is more sensitive than a YNAB token**, since it's full access to your Actual server, not a scoped credential.

#### Where does my Actual password go?

Only to the Actual server URL you configure — typically your own self-hosted instance. Budget Itemizer doesn't send it anywhere else and stores it in the **macOS Keychain** (the same place Safari stores your saved passwords).

#### What does Budget Itemizer do with my Actual credentials?

It connects to your Actual server, reads your budget categories and accounts, and creates split transactions. It doesn't change settings, modify other transactions, or alter anything outside the imports it makes.

#### Can I revoke access for Actual Budget?

Change your Actual server password. Budget Itemizer will lose access until you update it in settings. There's no token to revoke separately, so a password change is the only revocation mechanism.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup.

## Built with Claude

This project was built with [Claude Code](https://claude.ai). I brought the product vision — local-first, private, zero-config — and made the decisions. Claude wrote the code and guided the technical choices that served those goals.
