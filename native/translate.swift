import Foundation
import Translation

private struct Request: Decodable {
    let id: Int
    let text: String
}

private struct Reply: Encodable {
    var id: Int? = nil
    var text: String? = nil
    var error: String? = nil
    var ready: Bool? = nil
}

private func send(_ reply: Reply) {
    guard var data = try? JSONEncoder().encode(reply) else { return }
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
}

@main
struct Translator {
    static func main() async {
        guard #available(macOS 26.0, *) else {
            send(Reply(error: "同時翻訳にはmacOS 26以降が必要です"))
            return
        }
        let session = TranslationSession(
            installedSource: Locale.Language(identifier: "en"),
            target: Locale.Language(identifier: "ja")
        )
        do {
            // 録音前にモデルを準備し、最初の発言の翻訳待ちを減らす。
            _ = try await session.translate("Hello.")
            send(Reply(ready: true))
        } catch {
            send(Reply(error: "macOSの翻訳を準備できませんでした。設定の「一般 → 言語と地域 → 翻訳言語」で英語と日本語を確認してください。\(error.localizedDescription)"))
            return
        }
        if CommandLine.arguments.contains("--check") { return }

        while let line = readLine() {
            guard let data = line.data(using: .utf8),
                  let request = try? JSONDecoder().decode(Request.self, from: data) else {
                send(Reply(error: "翻訳する文を読み取れませんでした"))
                continue
            }
            do {
                let response = try await session.translate(request.text)
                send(Reply(id: request.id, text: response.targetText))
            } catch {
                send(Reply(id: request.id, error: "翻訳できませんでした: \(error.localizedDescription)"))
            }
        }
    }
}
