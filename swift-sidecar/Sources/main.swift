import Foundation
import Vision
import PDFKit
import FoundationModels

// MARK: - JSON helpers

func jsonOutput(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]),
          let str = String(data: data, encoding: .utf8) else {
        fputs("{\"error\":\"JSON serialization failed\"}\n", stderr)
        exit(1)
    }
    print(str)
}

func jsonError(_ message: String) -> Never {
    jsonOutput(["error": message])
    exit(1)
}

// MARK: - Capabilities

func capabilities() {
    var caps: [String: Any] = [
        "visionAvailable": true,  // VNRecognizeTextRequest works on macOS 13+
        "foundationModelsAvailable": false,
    ]

    // Foundation Models + RecognizeDocumentsRequest available on macOS 26+
    if #available(macOS 26.0, *) {
        caps["foundationModelsAvailable"] = true
        caps["documentRecognitionAvailable"] = true
    }

    jsonOutput(caps)
}

// MARK: - Vision: PDF OCR + document structure

struct PageResult {
    var text: String
    var lines: [[String: Any]]
    var detectedAmounts: [[String: Any]]
}

func extractAmounts(from text: String) -> [[String: Any]] {
    var amounts: [[String: Any]] = []
    // Match dollar amounts: $12.34, -$12.34, 12.34
    let pattern = #"-?\$?\d{1,}[,\d]*\.\d{2}\b"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return amounts }

    let range = NSRange(text.startIndex..., in: text)
    for match in regex.matches(in: text, range: range) {
        guard let matchRange = Range(match.range, in: text) else { continue }
        let raw = String(text[matchRange])
        let cleaned = raw.replacingOccurrences(of: "$", with: "")
                         .replacingOccurrences(of: ",", with: "")
        if let value = Double(cleaned) {
            amounts.append([
                "raw": raw,
                "value": value,
                "offset": match.range.location,
            ])
        }
    }
    return amounts
}

/// Run VNRecognizeTextRequest on a CGImage and return observations.
func recognizeText(in image: CGImage) -> [VNRecognizedTextObservation] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["en-US"]

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try? handler.perform([request])
    return request.results ?? []
}

/// Build a PageResult from Vision observations. Observations on the same
/// visual line (overlapping y-ranges) are joined with spaces left-to-right.
/// Bounding boxes are remapped from the crop region back to full-page
/// normalized coordinates.
func buildPageResult(from observations: [VNRecognizedTextObservation],
                     cropOrigin: (x: CGFloat, y: CGFloat) = (0, 0),
                     cropSize: (w: CGFloat, h: CGFloat) = (1, 1)) -> PageResult {
    // Build candidate list with remapped bboxes
    struct ObsEntry {
        let text: String
        let confidence: Float
        let pageX: CGFloat
        let pageY: CGFloat
        let pageW: CGFloat
        let pageH: CGFloat
    }

    var entries: [ObsEntry] = []
    for obs in observations {
        guard let candidate = obs.topCandidates(1).first else { continue }
        let bbox = obs.boundingBox
        entries.append(ObsEntry(
            text: candidate.string,
            confidence: candidate.confidence,
            pageX: cropOrigin.x + bbox.origin.x * cropSize.w,
            pageY: cropOrigin.y + bbox.origin.y * cropSize.h,
            pageW: bbox.size.width * cropSize.w,
            pageH: bbox.size.height * cropSize.h
        ))
    }

    // Group observations into visual lines by y-overlap.
    // Two observations are on the same visual line if their y-ranges overlap
    // by more than 50% of the shorter observation's height.
    // Sort top-to-bottom first (Vision y is bottom-up, so higher y = higher on page).
    let sorted = entries.sorted { $0.pageY > $1.pageY }
    var visualLines: [[ObsEntry]] = []

    for entry in sorted {
        let entryMidY = entry.pageY + entry.pageH / 2
        var merged = false
        for i in visualLines.indices.reversed() {
            // Compare against the first entry in the line to get the line's y-range
            let lineMinY = visualLines[i].map { $0.pageY }.min()!
            let lineMaxY = visualLines[i].map { $0.pageY + $0.pageH }.max()!
            let lineMidY = (lineMinY + lineMaxY) / 2
            let lineH = lineMaxY - lineMinY
            let threshold = min(entry.pageH, lineH) * 0.5

            if abs(entryMidY - lineMidY) < threshold {
                visualLines[i].append(entry)
                merged = true
                break
            }
        }
        if !merged {
            visualLines.append([entry])
        }
    }

    // Sort visual lines top-to-bottom, and entries within each line left-to-right
    visualLines.sort { a, b in
        let aY = a.map { $0.pageY + $0.pageH }.max()!
        let bY = b.map { $0.pageY + $0.pageH }.max()!
        return aY > bY
    }
    for i in visualLines.indices {
        visualLines[i].sort { $0.pageX < $1.pageX }
    }

    // Build output
    var lines: [[String: Any]] = []
    var fullText = ""

    for visualLine in visualLines {
        // Join text fragments on the same visual line with spaces
        let lineText = visualLine.map { $0.text }.joined(separator: " ")
        // Use the bounding box that spans the whole visual line
        let minX = visualLine.map { $0.pageX }.min()!
        let minY = visualLine.map { $0.pageY }.min()!
        let maxX = visualLine.map { $0.pageX + $0.pageW }.max()!
        let maxY = visualLine.map { $0.pageY + $0.pageH }.max()!
        let avgConfidence = visualLine.map { $0.confidence }.reduce(0, +) / Float(visualLine.count)

        lines.append([
            "text": lineText,
            "confidence": avgConfidence,
            "bbox": [
                "x": minX,
                "y": minY,
                "width": maxX - minX,
                "height": maxY - minY,
            ],
        ])

        if !fullText.isEmpty { fullText += "\n" }
        fullText += lineText
    }

    let amounts = extractAmounts(from: fullText)
    return PageResult(text: fullText, lines: lines, detectedAmounts: amounts)
}

func processPage(_ page: PDFPage, pageIndex: Int, scale: CGFloat = 2.0,
                  crop: (x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat)? = nil) -> PageResult? {
    guard let pageImage = renderPageToImage(page, scale: scale) else {
        fputs("Failed to render page \(pageIndex + 1) to image\n", stderr)
        return nil
    }

    // If crop region specified, crop the image first
    if let crop = crop {
        let imgW = CGFloat(pageImage.width)
        let imgH = CGFloat(pageImage.height)
        // Vision coords are bottom-left origin; CGImage is top-left
        let cropRect = CGRect(
            x: crop.x * imgW,
            y: (1.0 - crop.y - crop.h) * imgH,
            width: crop.w * imgW,
            height: crop.h * imgH
        )

        guard let croppedImage = pageImage.cropping(to: cropRect) else {
            fputs("Page \(pageIndex + 1): crop failed, using full image\n", stderr)
            let obs = recognizeText(in: pageImage)
            return buildPageResult(from: obs)
        }

        fputs("Page \(pageIndex + 1): cropped to \(croppedImage.width)x\(croppedImage.height)px\n", stderr)
        let obs = recognizeText(in: croppedImage)
        return buildPageResult(from: obs, cropOrigin: (crop.x, crop.y), cropSize: (crop.w, crop.h))
    }

    // No crop — run on full image
    let obs = recognizeText(in: pageImage)
    return buildPageResult(from: obs)
}

func renderPageToImage(_ page: PDFPage, scale: CGFloat = 2.0) -> CGImage? {
    let mediaBox = page.bounds(for: .mediaBox)
    let width = Int(mediaBox.width * scale)
    let height = Int(mediaBox.height * scale)

    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    // White background
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))

    context.scaleBy(x: scale, y: scale)

    // PDFPage.draw draws into the current graphics context
    page.draw(with: .mediaBox, to: context)

    return context.makeImage()
}

func visionExtract(inputPath: String, scale: CGFloat = 2.0, debugDir: String? = nil,
                   crop: (x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat)? = nil) {
    guard let document = PDFDocument(url: URL(fileURLWithPath: inputPath)) else {
        jsonError("Failed to open PDF: \(inputPath)")
    }

    if let crop = crop {
        fputs("Vision OCR at \(scale)x scale, crop: (\(crop.x), \(crop.y), \(crop.w), \(crop.h))\n", stderr)
    } else {
        fputs("Vision OCR at \(scale)x scale\n", stderr)
    }

    let pageCount = document.pageCount
    var pages: [[String: Any]] = []

    for i in 0..<pageCount {
        guard let page = document.page(at: i) else { continue }

        // Save rendered image for debugging
        if let debugDir = debugDir,
           let image = renderPageToImage(page, scale: scale) {
            let url = URL(fileURLWithPath: "\(debugDir)/page-\(i+1)-\(Int(scale))x.png")
            if let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) {
                CGImageDestinationAddImage(dest, image, nil)
                CGImageDestinationFinalize(dest)
                fputs("Saved debug image: \(url.path)\n", stderr)
            }
        }

        if let result = processPage(page, pageIndex: i, scale: scale, crop: crop) {
            pages.append([
                "pageNumber": i + 1,
                "text": result.text,
                "lines": result.lines,
                "detectedAmounts": result.detectedAmounts,
            ])
        }
    }

    jsonOutput(["pages": pages])
}

// MARK: - Vision: RecognizeDocumentsRequest (macOS 26+)

@available(macOS 26.0, *)
func visionDocExtract(inputPath: String) {
    guard let document = PDFDocument(url: URL(fileURLWithPath: inputPath)) else {
        jsonError("Failed to open PDF: \(inputPath)")
    }

    let semaphore = DispatchSemaphore(value: 0)
    var pagesResult: [[String: Any]] = []
    var errorMsg: String?

    Task {
        do {
            var pages: [[String: Any]] = []

            for i in 0..<document.pageCount {
                guard let pdfPage = document.page(at: i),
                      let pageImage = renderPageToImage(pdfPage) else { continue }

                // Convert CGImage to PNG data for RecognizeDocumentsRequest
                let bitmapRep = NSBitmapImageRep(cgImage: pageImage)
                guard let pngData = bitmapRep.representation(using: .png, properties: [:]) else {
                    continue
                }

                let request = RecognizeDocumentsRequest()
                let observations = try await request.perform(on: pngData)

                guard let docObs = observations.first else {
                    // No document detected on this page — skip
                    continue
                }

                let doc = docObs.document

                // Build structured text from the document hierarchy.
                // Many RecognizeDocumentsRequest types are Swift-only structs
                // that don't bridge to Objective-C (Locale.Currency,
                // NormalizedRect, etc.). All values must be explicitly
                // converted to String/Double/Int for JSONSerialization.
                let pageText: String = "\(doc.text.transcript)"

                // Build table data if any tables detected
                var tables: [[String: Any]] = []
                for table in doc.tables {
                    var tableRows: [[[String: Any]]] = []
                    for row in table.rows {
                        var rowCells: [[String: Any]] = []
                        for cell in row {
                            let cellText: String = "\(cell.content.text.transcript)"
                            var cellDict: [String: Any] = ["text": cellText]
                            var amounts: [[String: Any]] = []
                            for data in cell.content.text.detectedData {
                                if case .moneyAmount(let money) = data.match.details {
                                    amounts.append([
                                        "value": (money.amount as NSDecimalNumber).doubleValue,
                                        "currency": "\(money.currency)",
                                    ] as [String: Any])
                                }
                            }
                            if !amounts.isEmpty {
                                cellDict["amounts"] = amounts
                            }
                            rowCells.append(cellDict)
                        }
                        tableRows.append(rowCells)
                    }
                    tables.append(["rows": tableRows] as [String: Any])
                }

                // Collect all detected data (amounts, dates, etc.)
                var detectedAmounts: [[String: Any]] = []
                for data in doc.text.detectedData {
                    if case .moneyAmount(let money) = data.match.details {
                        detectedAmounts.append([
                            "value": (money.amount as NSDecimalNumber).doubleValue,
                            "currency": "\(money.currency)",
                        ] as [String: Any])
                    }
                }

                var pageDict: [String: Any] = [
                    "pageNumber": i + 1,
                    "text": pageText,
                    "detectedAmounts": detectedAmounts,
                ]
                if !tables.isEmpty {
                    pageDict["tables"] = tables
                }

                // Legacy-compatible lines with bboxes
                var lines: [[String: Any]] = []
                for line in doc.text.lines {
                    let rect = line.boundingRegion.boundingBox
                    let lineText: String = "\(line.transcript)"
                    lines.append([
                        "text": lineText,
                        "bbox": [
                            "x": Double(rect.origin.x),
                            "y": Double(rect.origin.y),
                            "width": Double(rect.width),
                            "height": Double(rect.height),
                        ] as [String: Any],
                    ] as [String: Any])
                }
                pageDict["lines"] = lines

                pages.append(pageDict)
            }
            pagesResult = pages
        } catch {
            errorMsg = "RecognizeDocumentsRequest failed: \(error)"
        }
        semaphore.signal()
    }

    semaphore.wait()

    if let error = errorMsg {
        jsonError(error)
    }
    jsonOutput(["pages": pagesResult])
}

// MARK: - Foundation Models: @Generable types

@available(macOS 26.0, *)
@Generable
struct FMLineItem {
    @Guide(description: "Verbatim text snippet identifying this item, 3-8 words as printed")
    var lineText: String
    @Guide(description: "Human-readable product name")
    var productName: String
    @Guide(description: "Per-line quantity, default 1")
    var quantity: Int
}

@available(macOS 26.0, *)
@Generable
struct FMLabelResult {
    @Guide(description: "Store or company name")
    var merchant: String
    @Guide(description: "Label text next to the final total, not the dollar amount")
    var totalLabel: String
    @Guide(description: "Every purchased item on this receipt")
    var lineItems: [FMLineItem]
}

@available(macOS 26.0, *)
@Generable
struct FMSummaryLabelItem {
    @Guide(description: "The label text as printed on the receipt, without dollar amounts")
    var label: String
    @Guide(description: "Semantic type", .anyOf(["tax", "shipping", "fee", "discount", "credit", "refund", "subtotal"]))
    var type: String
}

@available(macOS 26.0, *)
@Generable
struct FMSummaryResult {
    var summaryLabels: [FMSummaryLabelItem]
}

@available(macOS 26.0, *)
@Generable
struct FMCategoryResult {
    @Guide(description: "One category per item, in the same order as the input items")
    var categories: [String]
}

// MARK: - Foundation Models: Label extraction

func fmLabels() {
    guard #available(macOS 26.0, *) else {
        jsonError("Foundation Models require macOS 26+")
    }

    guard let inputData = readStdin() else {
        jsonError("No input on stdin")
    }

    guard let input = try? JSONSerialization.jsonObject(with: inputData) as? [String: Any],
          let text = input["text"] as? String else {
        jsonError("Expected JSON with 'text' field on stdin")
    }

    // Run async FM call synchronously via semaphore (CLI tool)
    let semaphore = DispatchSemaphore(value: 0)
    var resultDict: [String: Any]?
    var errorMsg: String?

    Task {
        do {
            let session = LanguageModelSession {
                """
                You extract structured data from receipt OCR text.

                Rules:
                - merchant: the store or company name only. DO NOT use a city, seller name, or location.
                - totalLabel: the word(s) labeling the final total. DO NOT include the dollar amount — just the label (e.g. 'Total', 'Order Total', 'Grand Total').
                - lineItems: include EVERY purchased item as a SEPARATE entry — one entry per receipt line. If the same product appears on 3 separate lines, include 3 entries.
                - lineText: 3-8 words verbatim from the receipt line, as printed including abbreviations. DO NOT include prices or quantities in lineText.
                - quantity: per-line only (e.g. 'Qty 2' or 'x3' on that same line). Default 1. DO NOT sum across multiple lines.
                """
            }
            let options = GenerationOptions(temperature: 0)
            let response = try await session.respond(
                to: "Extract the merchant, total label, and line items from this receipt:\n\(text)",
                generating: FMLabelResult.self,
                options: options
            )
            let result = response.content

            resultDict = [
                "merchant": result.merchant,
                "totalLabel": result.totalLabel,
                "lineItems": result.lineItems.map { [
                    "productName": $0.productName,
                    "quantity": $0.quantity,
                    "lineText": $0.lineText,
                ] as [String: Any] },
            ]
        } catch {
            errorMsg = "Foundation Models label extraction failed: \(error)"
        }
        semaphore.signal()
    }

    semaphore.wait()

    if let error = errorMsg {
        jsonError(error)
    }
    if let dict = resultDict {
        jsonOutput(dict)
    } else {
        jsonError("No result from Foundation Models")
    }
}

// MARK: - Foundation Models: Date extraction (single-question)

@available(macOS 26.0, *)
@Generable
struct FMDateResult {
    @Guide(description: "The purchase or order date exactly as printed, including year")
    var date: String
}

func fmDate() {
    guard #available(macOS 26.0, *) else {
        jsonError("Foundation Models require macOS 26+")
    }

    guard let inputData = readStdin() else {
        jsonError("No input on stdin")
    }

    guard let input = try? JSONSerialization.jsonObject(with: inputData) as? [String: Any],
          let text = input["text"] as? String else {
        jsonError("Expected JSON with 'text' field on stdin")
    }

    let semaphore = DispatchSemaphore(value: 0)
    var resultDict: [String: Any]?
    var errorMsg: String?

    Task {
        do {
            let session = LanguageModelSession {
                """
                Find the purchase or order date on this receipt. Look for labels like "Order placed", "Order date", "Date", or "Purchased on". Ignore delivery dates, shipping dates, return window dates, and browser print timestamps. The date MUST include the year.
                """
            }
            let options = GenerationOptions(temperature: 0)
            let response = try await session.respond(
                to: "What is the purchase/order date on this receipt?\n\(text)",
                generating: FMDateResult.self,
                options: options
            )
            resultDict = ["date": response.content.date]
        } catch {
            errorMsg = "\(error)"
        }
        semaphore.signal()
    }

    semaphore.wait()

    if let error = errorMsg {
        jsonError(error)
    }
    if let dict = resultDict {
        jsonOutput(dict)
    } else {
        jsonError("No result from Foundation Models")
    }
}

// MARK: - Foundation Models: Summary label extraction (single-question)

func fmSummary() {
    guard #available(macOS 26.0, *) else {
        jsonError("Foundation Models require macOS 26+")
    }

    guard let inputData = readStdin() else {
        jsonError("No input on stdin")
    }

    guard let input = try? JSONSerialization.jsonObject(with: inputData) as? [String: Any],
          let text = input["text"] as? String else {
        jsonError("Expected JSON with 'text' field on stdin")
    }

    let semaphore = DispatchSemaphore(value: 0)
    var resultDict: [String: Any]?
    var errorMsg: String?

    Task {
        do {
            let session = LanguageModelSession {
                """
                You find summary labels on receipts. A summary label is any word, phrase, or sentence that describes an order-level charge. These may be short (like "Tax") or long (like "Estimated tax to be collected"). They are NOT individual product names.

                Return ONLY the label text, NOT dollar amounts.

                DO NOT include individual product names or prices.
                DO NOT include payment method lines or card numbers.
                DO NOT include the final total label.
                ONLY output labels whose words actually appear in the receipt text. If there are none, return an empty array.
                """
            }
            let options = GenerationOptions(temperature: 0)
            let response = try await session.respond(
                to: "What summary labels appear on this receipt?\n\(text)",
                generating: FMSummaryResult.self,
                options: options
            )
            resultDict = [
                "summaryLabels": response.content.summaryLabels.map { [
                    "label": $0.label,
                    "type": $0.type,
                ] as [String: Any] },
            ]
        } catch {
            errorMsg = "\(error)"
        }
        semaphore.signal()
    }

    semaphore.wait()

    if let error = errorMsg {
        jsonError(error)
    }
    if let dict = resultDict {
        jsonOutput(dict)
    } else {
        jsonError("No result from Foundation Models")
    }
}

// MARK: - Foundation Models: Category assignment

func fmCategories() {
    guard #available(macOS 26.0, *) else {
        jsonError("Foundation Models require macOS 26+")
    }

    guard let inputData = readStdin() else {
        jsonError("No input on stdin")
    }

    guard let input = try? JSONSerialization.jsonObject(with: inputData) as? [String: Any],
          let items = input["items"] as? [[String: Any]],
          let categories = input["categories"] as? [String],
          let merchant = input["merchant"] as? String else {
        jsonError("Expected JSON with 'items', 'categories', and 'merchant' fields on stdin")
    }

    let semaphore = DispatchSemaphore(value: 0)
    var resultDict: [String: Any]?
    var errorMsg: String?

    let itemList = items.enumerated().map { i, item in
        let name = item["productName"] as? String ?? "Unknown"
        let amount = item["amount"] as? Double ?? 0
        return "\(i + 1). \"\(name)\" ($\(String(format: "%.2f", amount)))"
    }.joined(separator: "\n")

    let categoryList = categories.joined(separator: ", ")

    Task {
        do {
            let session = LanguageModelSession {
                "You categorize purchases into budget categories. Pick from the provided list exactly as written, including any emoji prefixes. If nothing fits, use Uncategorized. Return EXACTLY one category per item, in the same order. No more, no fewer."
            }
            let options = GenerationOptions(temperature: 0)
            let response = try await session.respond(
                to: "Merchant: \(merchant)\n\n\(items.count) items to categorize:\n\(itemList)\n\nCategories: \(categoryList)\n\nReturn exactly \(items.count) categories.",
                generating: FMCategoryResult.self,
                options: options
            )
            resultDict = ["categories": response.content.categories]
        } catch {
            errorMsg = "Foundation Models category assignment failed: \(error)"
        }
        semaphore.signal()
    }

    semaphore.wait()

    if let error = errorMsg {
        jsonError(error)
    }
    if let dict = resultDict {
        jsonOutput(dict)
    } else {
        jsonError("No result from Foundation Models")
    }
}

// MARK: - Stdin helper

func readStdin() -> Data? {
    var data = Data()
    let bufferSize = 65536
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
    defer { buffer.deallocate() }

    while true {
        let bytesRead = fread(buffer, 1, bufferSize, stdin)
        if bytesRead == 0 { break }
        data.append(buffer, count: bytesRead)
    }

    return data.isEmpty ? nil : data
}

// MARK: - Vision: crop test

func visionCropTest(inputPath: String, scale: CGFloat, cx: Double, cy: Double, cw: Double, ch: Double) {
    guard let document = PDFDocument(url: URL(fileURLWithPath: inputPath)),
          let page = document.page(at: 0),
          let fullImage = renderPageToImage(page, scale: scale) else {
        jsonError("Failed to render PDF")
    }

    // Crop region (normalized 0-1 coords, Vision uses bottom-left origin)
    let imgW = CGFloat(fullImage.width)
    let imgH = CGFloat(fullImage.height)
    let cropRect = CGRect(
        x: cx * Double(imgW),
        y: cy * Double(imgH),
        width: cw * Double(imgW),
        height: ch * Double(imgH)
    )

    guard let cropped = fullImage.cropping(to: cropRect) else {
        jsonError("Failed to crop image")
    }

    fputs("Cropped: \(cropped.width)x\(cropped.height) from \(fullImage.width)x\(fullImage.height)\n", stderr)

    // Save cropped image for inspection
    let url = URL(fileURLWithPath: "/tmp/receipt-debug/cropped.png")
    if let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) {
        CGImageDestinationAddImage(dest, cropped, nil)
        CGImageDestinationFinalize(dest)
        fputs("Saved: \(url.path)\n", stderr)
    }

    // Run Vision on cropped image
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["en-US"]

    let handler = VNImageRequestHandler(cgImage: cropped, options: [:])
    try! handler.perform([request])

    var lines: [[String: Any]] = []
    for obs in (request.results ?? []) {
        guard let candidate = obs.topCandidates(1).first else { continue }
        lines.append([
            "text": candidate.string,
            "confidence": candidate.confidence,
        ])
    }

    jsonOutput(["lines": lines, "width": cropped.width, "height": cropped.height])
}

// MARK: - CLI entry point

let args = CommandLine.arguments.dropFirst()

guard let command = args.first else {
    fputs("Usage: swift-sidecar <capabilities|vision|vision-doc|fm-labels|fm-date|fm-summary|fm-categories>\n", stderr)
    exit(1)
}

switch command {
case "capabilities":
    capabilities()

case "vision":
    // Input arrives as JSON on stdin — keeps the PDF path out of `ps`
    // listings visible to other same-user processes.
    guard let stdinData = readStdin(),
          let stdinJson = try? JSONSerialization.jsonObject(with: stdinData) as? [String: Any],
          let path = stdinJson["input"] as? String else {
        jsonError("Usage: swift-sidecar vision (stdin JSON: {input, scale?, crop?, debug?})")
    }
    var scale: CGFloat = 2.0
    if let s = stdinJson["scale"] as? Double { scale = CGFloat(s) }
    let debugDir = stdinJson["debug"] as? String
    var crop: (x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat)? = nil
    if let cropStr = stdinJson["crop"] as? String {
        let parts = cropStr.split(separator: ",").compactMap { Double($0) }
        if parts.count == 4 {
            crop = (CGFloat(parts[0]), CGFloat(parts[1]), CGFloat(parts[2]), CGFloat(parts[3]))
        }
    }
    visionExtract(inputPath: path, scale: scale, debugDir: debugDir, crop: crop)

case "vision-doc":
    guard let stdinData = readStdin(),
          let stdinJson = try? JSONSerialization.jsonObject(with: stdinData) as? [String: Any],
          let path = stdinJson["input"] as? String else {
        jsonError("Usage: swift-sidecar vision-doc (stdin JSON: {input})")
    }
    if #available(macOS 26.0, *) {
        visionDocExtract(inputPath: path)
    } else {
        jsonError("vision-doc requires macOS 26+")
    }

case "vision-crop":
    guard let inputIdx = args.firstIndex(of: "--input"),
          let inputPath = args[args.index(after: inputIdx)...].first else {
        jsonError("Usage: swift-sidecar vision-crop --input <pdf> --scale N --crop x,y,w,h")
    }
    var cropScale: CGFloat = 6.0
    if let scaleIdx = args.firstIndex(of: "--scale"),
       let scaleStr = args[args.index(after: scaleIdx)...].first,
       let scaleVal = Double(scaleStr) {
        cropScale = CGFloat(scaleVal)
    }
    guard let cropIdx = args.firstIndex(of: "--crop"),
          let cropStr = args[args.index(after: cropIdx)...].first else {
        jsonError("--crop x,y,w,h required (normalized 0-1)")
    }
    let parts = cropStr.split(separator: ",").compactMap { Double($0) }
    guard parts.count == 4 else { jsonError("--crop needs 4 values: x,y,w,h") }
    visionCropTest(inputPath: inputPath, scale: cropScale, cx: parts[0], cy: parts[1], cw: parts[2], ch: parts[3])

case "fm-labels":
    fmLabels()

case "fm-date":
    fmDate()

case "fm-summary":
    fmSummary()

case "fm-categories":
    fmCategories()

default:
    jsonError("Unknown command: \(command)")
}
