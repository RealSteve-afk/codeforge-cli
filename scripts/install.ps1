# CodeForge CLI installer. No admin. Never installs a system Node via OS packages.
# Windows PowerShell:
#   irm https://www.codeforge.dev/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$NpmPackage = if ($env:CODEFORGE_NPM_PACKAGE) { $env:CODEFORGE_NPM_PACKAGE } else { '@realsteve-afk/codeforge-cli' }
$NodeVersion = if ($env:CODEFORGE_NODE_VERSION) { $env:CODEFORGE_NODE_VERSION } else { '22.23.2' }
$NodeDist = if ($env:CODEFORGE_NODE_DIST) { $env:CODEFORGE_NODE_DIST } else { 'https://nodejs.org/dist' }
$CodeForgeHome = if ($env:CODEFORGE_HOME) { $env:CODEFORGE_HOME } else { Join-Path $HOME '.codeforge' }

function Write-CodeForge([string]$Message) {
    Write-Host "codeforge: $Message"
}

function Get-CurlExe {
    $cmd = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Download-CodeForgeFile([string]$Url, [string]$Dest, [bool]$ShowProgress) {
    $curl = Get-CurlExe
    if ($curl) {
        if ($ShowProgress) {
            & $curl -fL -# -o $Dest $Url
        } else {
            & $curl -fsSL -o $Dest $Url
        }
        if ($LASTEXITCODE -ne 0) { throw "download failed: $Url" }
        return
    }
    $previous = $ProgressPreference
    if ($ShowProgress) { $ProgressPreference = 'Continue' }
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
    } finally {
        $ProgressPreference = $previous
    }
}

function Get-NodeMajor([string]$NodeExe) {
    try {
        $raw = & $NodeExe -p "process.versions.node.split('.')[0]" 2>$null
        return [int]$raw
    } catch {
        return 0
    }
}

function Test-UsableNode {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { return $false }
    return (Get-NodeMajor $cmd.Source) -ge 20
}

function Get-WinNodeArch {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -eq 'ARM64') { return 'arm64' }
    return 'x64'
}

function Install-PrivateNode {
    $arch = Get-WinNodeArch
    $folder = "node-v$NodeVersion-win-$arch"
    $zipName = "$folder.zip"
    $url = "$NodeDist/v$NodeVersion/$zipName"
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("codeforge-node-" + [guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    Write-CodeForge "installing Node $NodeVersion into $CodeForgeHome\node (user-local, not system npm)"
    Write-CodeForge "downloading Node $NodeVersion (~30MB)"
    $zipPath = Join-Path $tmp $zipName
    Download-CodeForgeFile -Url $url -Dest $zipPath -ShowProgress $true
    Write-CodeForge "verifying Node checksum"
    $sumsPath = Join-Path $tmp 'SHASUMS256.txt'
    Download-CodeForgeFile -Url "$NodeDist/v$NodeVersion/SHASUMS256.txt" -Dest $sumsPath -ShowProgress $false
    $sums = Get-Content -Raw $sumsPath
    $expected = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($zipName) } | Select-Object -First 1)
    if (-not $expected) { throw "no checksum for $zipName" }
    $want = ($expected -split '\s+')[0].ToLowerInvariant()
    $got = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($want -ne $got) { throw "Node checksum mismatch" }
    Write-CodeForge "extracting Node"
    Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Path $CodeForgeHome -Force | Out-Null
    $dest = Join-Path $CodeForgeHome 'node'
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Move-Item (Join-Path $tmp $folder) $dest
    Remove-Item -Recurse -Force $tmp
}

function Resolve-Npm {
    $privateNpm = Join-Path $CodeForgeHome 'node\npm.cmd'
    if (Test-Path $privateNpm) { return $privateNpm }
    if ((Test-UsableNode) -and (Get-Command npm -ErrorAction SilentlyContinue)) {
        return (Get-Command npm).Source
    }
    Install-PrivateNode
    return (Join-Path $CodeForgeHome 'node\npm.cmd')
}

function Use-CodeForgeNodeOnPath {
    $nodeDir = Join-Path $CodeForgeHome 'node'
    $nodeExe = Join-Path $nodeDir 'node.exe'
    if (-not (Test-Path $nodeExe)) { return }
    # npm lifecycle scripts spawn `cmd /c node scripts/postinstall.js` and look
    # up `node` on PATH. The private runtime is not on PATH until after install.
    $env:Path = "$nodeDir;$env:Path"
    $env:npm_config_scripts_prepend_node_path = 'true'
}

function Add-UserPath([string]$Dir) {
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $current) { $current = '' }
    $parts = @($current.Split(';') | Where-Object { $_ -and ($_.TrimEnd('\') -ine $Dir.TrimEnd('\')) })
    $next = ($parts + $Dir) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $next, 'User')
    if ($env:Path -notlike "*${Dir}*") {
        $env:Path = "$Dir;$env:Path"
    }
}

New-Item -ItemType Directory -Path $CodeForgeHome -Force | Out-Null
Write-CodeForge "installing $NpmPackage into $CodeForgeHome"
$npm = Resolve-Npm
Use-CodeForgeNodeOnPath
Write-CodeForge "npm -> $npm"
Write-CodeForge "installing package (this may take a minute)"
& $npm install -g --prefix $CodeForgeHome $NpmPackage
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

# PowerShell resolves `codeforge` to codeforge.ps1 ahead of codeforge.cmd, and the default
# Restricted policy refuses to run scripts. npm recreates its shim every
# install, so this has to run after npm, not only in the package postinstall.
# A failure must not skip the PATH setup below.
$ps1Shim = Join-Path $CodeForgeHome 'codeforge.ps1'
if (Test-Path $ps1Shim) {
    try { Remove-Item -Force -ErrorAction Stop $ps1Shim } catch { }
    if (Test-Path $ps1Shim) {
        Write-CodeForge "could not delete $ps1Shim"
        Write-CodeForge "if ``codeforge`` reports a script error, delete that file or run: Set-ExecutionPolicy RemoteSigned -Scope CurrentUser"
    }
}

$nodeDir = Join-Path $CodeForgeHome 'node'
Add-UserPath $CodeForgeHome
if (Test-Path $nodeDir) { Add-UserPath $nodeDir }
$shimDir = Join-Path $env:LOCALAPPDATA 'codeforge\bin'
if (Test-Path $shimDir) { Add-UserPath $shimDir }
Write-CodeForge "added $CodeForgeHome to user PATH"

$codeforgeCmd = Join-Path $CodeForgeHome 'codeforge.cmd'
Write-CodeForge "command -> $codeforgeCmd"
Write-CodeForge "next: $codeforgeCmd login ; $codeforgeCmd"
