import { execFileSync } from 'node:child_process'
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SCMORC_PATH = fileURLToPath(new URL('../.scmorc', import.meta.url))
const CENSUS_KEY_RE = /^[0-9a-f]{40}$/i
const WINDOWS_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CensusScmorcFileIdentity {
  [StructLayout(LayoutKind.Sequential)] private struct Info {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
    public System.Runtime.InteropServices.ComTypes.FILETIME Access;
    public System.Runtime.InteropServices.ComTypes.FILETIME Write;
    public uint Volume;
    public uint SizeHigh;
    public uint SizeLow;
    public uint Links;
    public uint IndexHigh;
    public uint IndexLow;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  public static string Get(SafeFileHandle handle) {
    Info info;
    if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return info.Volume.ToString() + ":" + (((ulong)info.IndexHigh << 32) | info.IndexLow).ToString();
  }
}
'@
Add-Type -TypeDefinition $source
$file = [System.IO.File]::Open($env:CENSUS_KEY_ACL_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
try {
$identity = [CensusScmorcFileIdentity]::Get($file.SafeFileHandle)
$expectedIdentity = $env:CENSUS_KEY_EXPECTED_DEV + ':' + $env:CENSUS_KEY_EXPECTED_INO
$acl = Get-Acl -LiteralPath $env:CENSUS_KEY_ACL_PATH
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  [pscustomobject]@{
    sid = $_.IdentityReference.Value
    type = $_.AccessControlType.ToString()
    inherited = $_.IsInherited
  }
})
[pscustomobject]@{
  ownerSid = $ownerSid
  currentSid = $currentSid
  identityMatches = ($identity -eq $expectedIdentity)
  protected = $acl.AreAccessRulesProtected
  rules = $rules
} | ConvertTo-Json -Compress -Depth 4
} finally {
  $file.Dispose()
}
`

export function isPrivateScmorcAcl(acl) {
  const rules = Array.isArray(acl?.rules) ? acl.rules : []
  return (
    typeof acl?.currentSid === 'string' &&
    acl.ownerSid === acl.currentSid &&
    acl.identityMatches === true &&
    acl.protected === true &&
    rules.length > 0 &&
    rules.every(
      (rule) =>
        rule?.sid === acl.currentSid && rule.type === 'Allow' && rule.inherited === false,
    )
  )
}

export function parseCensusKeyFromScmorc(contents) {
  const keyLines = contents.split(/\r?\n/).filter((entry) => entry.startsWith('CENSUS_KEY='))
  if (keyLines.length === 0) return undefined
  if (keyLines.length > 1) {
    throw new Error('CENSUS_KEY must appear exactly once in .scmorc.')
  }

  const key = keyLines[0].slice('CENSUS_KEY='.length)
  if (!CENSUS_KEY_RE.test(key)) {
    throw new Error('CENSUS_KEY in .scmorc must be a 40-character hexadecimal Census key.')
  }
  return key
}

function assertScmorcIsPrivate(stats) {
  if (process.platform === 'win32') {
    let aclOutput
    try {
      aclOutput = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_ACL_SCRIPT],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            CENSUS_KEY_ACL_PATH: SCMORC_PATH,
            CENSUS_KEY_EXPECTED_DEV: stats.dev.toString(),
            CENSUS_KEY_EXPECTED_INO: stats.ino.toString(),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )
    } catch {
      throw new Error('Could not verify .scmorc access permissions; refusing to load CENSUS_KEY.')
    }

    let acl
    try {
      acl = JSON.parse(aclOutput)
    } catch {
      throw new Error('Could not verify .scmorc access permissions; refusing to load CENSUS_KEY.')
    }

    if (!isPrivateScmorcAcl(acl)) {
      throw new Error('.scmorc must be owned by the current user and accessible only to that user.')
    }
    return
  }

  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null
  if (
    currentUid === null ||
    stats.uid !== BigInt(currentUid) ||
    (stats.mode & 0o077n) !== 0n
  ) {
    throw new Error('.scmorc must be owned by the current user and inaccessible to other accounts.')
  }
}

/** Load the local Census testing key without printing it or overriding the environment. */
export function loadCensusKeyFromScmorc() {
  if (process.env.CENSUS_KEY) return

  let fileDescriptor
  try {
    const pathStats = lstatSync(SCMORC_PATH, { bigint: true })
    if (!pathStats.isFile()) {
      throw new Error('.scmorc must be a regular file; refusing to load CENSUS_KEY.')
    }

    fileDescriptor = openSync(SCMORC_PATH, 'r')
    const openedStats = fstatSync(fileDescriptor, { bigint: true })
    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino
    ) {
      throw new Error('.scmorc changed while opening; refusing to load CENSUS_KEY.')
    }

    // The ACL check holds a read-only Windows handle and verifies its file ID; read from this same handle.
    assertScmorcIsPrivate(openedStats)

    const contents = readFileSync(fileDescriptor, 'utf8')
    const key = parseCensusKeyFromScmorc(contents)
    if (!key) return

    process.env.CENSUS_KEY = key
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor)
  }
}
