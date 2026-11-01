# Build the app and run the four Census-backed browser checks using .scmorc.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSCommandPath
$previewProcess = $null
$logDirectory = $null
$locationPushed = $false
$exitCode = 1

try {
    if ([Environment]::GetEnvironmentVariable('CENSUS_KEY', 'Process')) {
        throw 'CENSUS_KEY is already set in this PowerShell process. Clear it so this run uses .scmorc.'
    }

    Push-Location -LiteralPath $repoRoot
    $locationPushed = $true
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE." }

    $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
    $viteCli = Join-Path $repoRoot 'node_modules/vite/bin/vite.js'
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $previewUrl = "http://127.0.0.1:$port"

    $logDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("civicscope-preview-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $logDirectory | Out-Null
    $previewProcess = Start-Process -FilePath $nodeExe `
        -ArgumentList @($viteCli, 'preview', '--host', '127.0.0.1', '--port', "$port", '--strictPort') `
        -WorkingDirectory $repoRoot -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDirectory 'stdout.log') `
        -RedirectStandardError (Join-Path $logDirectory 'stderr.log') -PassThru

    $ready = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($previewProcess.HasExited) { throw 'Preview exited before becoming ready.' }
        try {
            $response = Invoke-WebRequest -Uri "$previewUrl/" -TimeoutSec 2 -UseBasicParsing
            if ($response.StatusCode -eq 200 -and $response.Headers['Content-Type'] -match 'text/html') {
                $ready = $true
                break
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw 'Preview did not become ready within 30 seconds.' }

    $nodeRunner = @'
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const [previewUrl, repoRoot] = process.argv.slice(2);
const titles = [
  "loads a national set of ZIP codes in one request",
  "shows household counts that differ between ZIP codes",
  "renders real published figures with their margin of error",
  "keeps ZIP order by default, sorts locally, and renders Similarity matches without metric values",
];
const pattern = "(?:^|\\s)(?:" + titles.join("|") + ")$";
let key = "";
 (async () => {
  try {
  const loaderUrl = pathToFileURL(path.join(repoRoot, "tools", "load-census-key.mjs"));
  const { loadCensusKeyFromScmorc } = await import(loaderUrl.href);
  loadCensusKeyFromScmorc();
  key = process.env.CENSUS_KEY || "";
  if (!/^[0-9a-f]{40}$/i.test(key)) throw new Error("A valid Census key was not loaded from .scmorc.");

  const vitest = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
  const run = spawnSync(process.execPath, [vitest, "run", "--config", "vitest.e2e.config.ts", `--testNamePattern=${pattern}`, "--reporter=json"], {
    cwd: repoRoot,
    env: { ...process.env, E2E_BASE_URL: previewUrl },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  const output = (run.stdout || "") + (run.stderr || "");
  const safeOutput = key ? output.split(key).join("[REDACTED]") : output;
  let report;
  for (const line of safeOutput.split(/\r?\n/)) {
    try {
      const candidate = JSON.parse(line);
      if (Array.isArray(candidate?.testResults)) report = candidate;
    } catch { }
  }

  const assertions = (report?.testResults || []).flatMap((file) => file.assertionResults || []);
  const matches = titles.map((title) => assertions.filter((test) => test.title === title));
  for (let i = 0; i < titles.length; i++) {
    console.log(`${matches[i].length === 1 ? matches[i][0].status.toUpperCase() : "MISSING OR DUPLICATED"}: ${titles[i]}`);
  }
  const passed = matches.every((tests) => tests.length === 1 && tests[0].status === "passed");
  if (run.error) console.error("Vitest could not start: " + run.error.message);
  if (run.status !== 0 || !passed || report?.numPassedTests !== titles.length || report?.numFailedTests !== 0) {
    if (!report) console.error(safeOutput.replace(/\s+/g, " ").slice(0, 1000) || "Vitest did not emit a JSON report.");
    process.exitCode = 1;
  } else {
    console.log("All four targeted E2E tests passed; none were skipped.");
  }
} catch (error) {
  const message = String(error?.message || "Census E2E runner failed");
  console.error(key ? message.split(key).join("[REDACTED]") : message);
  process.exitCode = 1;
}
})();
'@
    $nodeRunner | & $nodeExe - $previewUrl $repoRoot
    $exitCode = $LASTEXITCODE
}
catch {
    Write-Host "Stopped: $($_.Exception.Message)"
    $exitCode = 1
}
finally {
    if ($null -ne $previewProcess -and -not $previewProcess.HasExited) {
        Stop-Process -Id $previewProcess.Id -Force -ErrorAction SilentlyContinue
        $previewProcess.WaitForExit(5000) | Out-Null
    }
    if ($null -ne $logDirectory -and (Test-Path -LiteralPath $logDirectory)) {
        Get-ChildItem -LiteralPath $logDirectory -File -ErrorAction SilentlyContinue |
            Remove-Item -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $logDirectory -Force -ErrorAction SilentlyContinue
    }
    if ($locationPushed) { Pop-Location }
}

exit $exitCode
