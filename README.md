# Budget Itemizer

**Know how much you're *really* spending — receipt by receipt, line by line.**

<!-- Screenshot or short demo GIF goes here. Recommended: a clip showing a PDF drop → review → import flow. -->

## What it is

YNAB is great for budgeting, but it doesn't help you understand how your money gets spent within a big purchase. You might buy shampoo, rotisserie chicken, batteries, and a blanket in the same order — how do you categorize that transaction? YNAB does provide transaction splitting, but it's slow, manual work. Commercial solutions for receipt import exist, but they require paying more money on top of your existing YNAB subscription and giving one more company your data.

Budget Itemizer takes your online order receipt and separates the transaction into its line items. Then it uploads the split transaction back to YNAB. The app downloads an AI model during initial setup; the processing itself runs locally on your machine.

Drop a PDF into the inbox folder or drag it into the app window, and watch it go to work.

### How it works

1. **Drop a receipt** — Drag a PDF into the app or save it to the inbox folder.
2. **Review the split** — The AI parses line items and maps them to your YNAB categories. Edit anything it got wrong.
3. **Import to YNAB** — One click and the split transaction lands in your budget.

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

Your data goes to *your* YNAB account, from *your* computer. That's it. Budget Itemizer is not a cloud service — there's no server we run, no account you create with us, no telemetry, and no analytics. The receipt parsing happens locally on your machine via a bundled language model. The only network requests are the YNAB API calls from they app to your account, plus the one-time model download from [Hugging Face](https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF) during setup. The code is open — you can read it and verify.

#### Does my data go to OpenAI, Anthropic, or any other AI company?

No. The receipt parsing uses a local copy of [Llama 3.1 8B](https://www.llama.com/) by Meta, running entirely on your Mac. No prompts, receipts, or transaction details are sent to any AI provider. This is the whole point: small open models running locally are more than capable of this kind of structured extraction work, and they don't require trusting a third party with your data.

#### Why isn't the app signed or notarized?

Budget Itemizer is in public beta. Apple Developer Program membership costs $99/year and I am keeping costs at zero until there's signal that people want this. Once it's clear the project has legs, signing is the next step. Until then, see the Gatekeeper bypass instructions above; you only have to do it once.

### How it works

#### What receipts work?

Tested formats: order invoices from Amazon, Walmart, Costco, Kroger, Target. These are typically downloaded as PDFs from your order history (press Cmd+p while viewing the invoice page and save as PDF). Register tape photos, scanned paper receipts, and email-only receipts aren't the target, although they might work (Costco's downloaded receipts already look like this). Your mileage will vary.

#### Why is the model so big?

Llama 3.1 8B is ~4.9 GB. It's downloaded once, lives in `~/.config/budget-itemizer/models/`, and runs entirely on your Mac. You can delete it any time from Settings → Models → Delete. The size is the cost of running a capable model locally, and it's the reason your data doesn't have to leave your machine.

#### Why Apple Silicon only?

Budget Itemizer relies on Apple Silicon's unified memory and GPU acceleration to run Llama 3.1 8B at usable speed. Expanding hardware/OS support is possible later but isn't a priority for this beta. 

#### Does it work offline?

Yes — once setup is complete and the model is downloaded, receipt parsing works without an internet connection. The only thing that requires internet is syncing your splits to YNAB's server.

#### How do I report a bug or request a feature?

Open an issue at [github.com/danifuldan/budget-itemizer/issues](https://github.com/danifuldan/budget-itemizer/issues). Include what you expected, what happened, and any errors from the app's status bar or logs (Settings → "Reveal app logs in Finder").

### Credentials

#### Is it safe to paste my YNAB API token here?

Yes. Budget Itemizer stores your token in the **macOS Keychain** — the same place Safari stores your saved passwords — and only sends it to YNAB itself. Nothing is sent anywhere else. You can revoke the token at any time from YNAB's [settings](https://app.ynab.com/settings/developer).

#### How do I get a YNAB API token?

In YNAB, go to **Account Settings → Developer Settings → New Token**. Copy the generated token and paste it into Budget Itemizer's setup wizard. Direct link: [app.ynab.com/settings/developer](https://app.ynab.com/settings/developer).

#### What does Budget Itemizer do with my token?

It uses the token to read your budget categories and accounts (so it can predict the right category for each line item) and to create split transactions in YNAB. Nothing else.

#### Can I revoke the token later?

Yes. Go to **Account Settings → Developer Settings** in YNAB and delete the token. Budget Itemizer will stop working until you generate a new one.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup.

## About this project

Built collaboratively with [Claude Code](https://claude.ai). I brought the product vision — local-first, private, zero-config — and made the decisions. Claude wrote the code and guided the technical choices that served those goals.

## License

[GPL-3.0](LICENSE).
