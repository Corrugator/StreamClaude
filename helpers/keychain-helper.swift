// Tiny Swift CLI that talks to the macOS keychain via the Security framework.
//
// Used for both READ and WRITE so the plugin never has to shell out to
// `/usr/bin/security`:
//   - Write avoids leaking the secret via argv.
//   - Read avoids the per-poll "always allow" prompt that the OS shows for
//     `/usr/bin/security` whenever the keychain item's partition list does
//     not include `apple-tool`. The helper has its own ad-hoc code signature,
//     so the user's "Always Allow" decision sticks for this binary.
//
// Usage:
//   keychain-helper read  <service> <account>
//     → prints the stored blob to stdout, no trailing newline added.
//   keychain-helper write <service> <account>
//     → reads the new blob from stdin and stores it.
//
// Exit codes:
//   0  success
//   1  bad arguments
//   2  stdin read failed (write only)
//   3  keychain operation failed (OSStatus printed on stderr)
//   4  keychain item not found (read only)

import Foundation
import Security

let args = CommandLine.arguments
guard args.count == 4, (args[1] == "write" || args[1] == "read") else {
  fputs("Usage: keychain-helper <read|write> <service> <account>\n", stderr)
  exit(1)
}

let mode    = args[1]
let service = args[2]
let account = args[3]

let baseQuery: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account,
]

func failOSStatus(_ status: OSStatus, _ what: String) -> Never {
  let msg = SecCopyErrorMessageString(status, nil) as String? ?? "unknown"
  fputs("ERROR: \(what) failed: OSStatus=\(status) (\(msg))\n", stderr)
  exit(status == errSecItemNotFound ? 4 : 3)
}

switch mode {

case "read":
  var query = baseQuery
  query[kSecReturnData as String] = true
  query[kSecMatchLimit as String]  = kSecMatchLimitOne
  var result: CFTypeRef?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  guard status == errSecSuccess, let data = result as? Data else {
    failOSStatus(status, "read")
  }
  FileHandle.standardOutput.write(data)

case "write":
  // Stream Deck pipes a small JSON blob; a single read is fine.
  let data: Data = FileHandle.standardInput.readDataToEndOfFile()
  guard !data.isEmpty else {
    fputs("ERROR: empty stdin\n", stderr)
    exit(2)
  }
  // Try update first, fall back to add — mirrors `security add-generic-password -U`.
  let updateAttrs: [String: Any] = [kSecValueData as String: data]
  var status = SecItemUpdate(baseQuery as CFDictionary, updateAttrs as CFDictionary)
  if status == errSecItemNotFound {
    var addAttrs = baseQuery
    addAttrs[kSecValueData as String] = data
    status = SecItemAdd(addAttrs as CFDictionary, nil)
  }
  guard status == errSecSuccess else { failOSStatus(status, "write") }

default:
  fputs("Usage: keychain-helper <read|write> <service> <account>\n", stderr)
  exit(1)
}
