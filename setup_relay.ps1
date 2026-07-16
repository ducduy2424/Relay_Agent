# Cài Unicorn Relay Agent lên máy thu ngân của chi nhánh.
#   powershell -ExecutionPolicy Bypass -File setup_relay.ps1
# Yêu cầu: chạy Administrator; .env đã trỏ đúng SERVER_URL/AGENT_TOKEN/BRANCH_ID.
# Task Scheduler "Unicorn Relay Agent": /sc onstart /ru SYSTEM → chạy `node supervisor.js`
# ngay lúc boot, KHÔNG cần thu ngân login (SYSTEM session 0 → không cần VBS ẩn cửa sổ).

[CmdletBinding()]
param(
  [string]$NodeMsiPath = "",
  [switch]$SkipNodeInstall,
  [switch]$SkipNpmInstall,
  # Chống deploy nhầm chi nhánh: nếu truyền, .env BRANCH_ID phải khớp giá trị này.
  [int]$ExpectedBranchId = -1,
  # 0=cao nhất .. 10=thấp nhất; mặc định Windows = 7.
  [ValidateRange(0, 10)]
  [int]$TaskPriority = 4
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$TaskName = "Unicorn Relay Agent"

function Write-Step {
  param([string]$Message)
  Write-Host "[setup] $Message" -ForegroundColor Cyan
}

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Please run this script as Administrator."
  }
}

function Invoke-External {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$Operation
  )

  # 1) PHẢI dùng $global:LASTEXITCODE: gán `$LASTEXITCODE = 0` trong hàm tạo biến CỤC BỘ
  #    che biến global mà lệnh native thật sự set → exit code đọc được luôn là 0, mọi lỗi
  #    msiexec/npm bị nuốt và setup báo "thành công" giả.
  # 2) Hạ EAP về Continue quanh lệnh native: dưới PS 5.1, `2>&1` + EAP Stop biến DÒNG STDERR
  #    ĐẦU TIÊN (vd "npm warn deprecated") thành lỗi terminating dù exit 0 → abort oan.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $global:LASTEXITCODE = 0
    $output = & $FilePath @Arguments 2>&1
    $exitCode = $global:LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $prevEap
  }

  if ($output) {
    $output | ForEach-Object { Write-Host $_ }
  }

  if ($exitCode -ne 0) {
    $details = if ($output) { ($output -join [Environment]::NewLine) } else { "(no output)" }
    throw "$Operation failed (exit code $exitCode).`n$details"
  }
}

function Get-FirstExistingPath {
  param([string[]]$Candidates)
  foreach ($candidate in $Candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  return $null
}

function Get-NodeExePath {
  $fromCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($fromCommand -and (Test-Path -LiteralPath $fromCommand.Source)) {
    return $fromCommand.Source
  }

  $candidate = Get-FirstExistingPath -Candidates @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe"
  )

  if ($null -eq $candidate) {
    throw "node.exe was not found."
  }

  return $candidate
}

function Install-NodeIfNeeded {
  param([string]$MsiPath)

  if ($SkipNodeInstall) {
    Write-Step "Skip Node.js install."
    return
  }

  $existingNode = Get-Command node -ErrorAction SilentlyContinue
  if ($existingNode) {
    Write-Step "Node.js already installed: $($existingNode.Source)"
    return
  }

  if ([string]::IsNullOrWhiteSpace($MsiPath) -or -not (Test-Path -LiteralPath $MsiPath)) {
    throw "Node.js is not installed and no MSI was found. Pass -NodeMsiPath <path-to-node-msi>."
  }

  Write-Step "Installing Node.js from $MsiPath"
  Invoke-External -FilePath "msiexec.exe" -Arguments @(
    "/i",
    $MsiPath,
    "/qn",
    "/norestart"
  ) -Operation "Install Node.js"
}

function Install-NpmDependencies {
  param([string]$ProjectRoot)

  if ($SkipNpmInstall) {
    Write-Step "Skip npm install."
    return
  }

  $nodeExe = Get-NodeExePath
  $nodeDir = Split-Path -Parent $nodeExe
  $npmCli = Join-Path $nodeDir "node_modules\npm\bin\npm-cli.js"

  if (-not (Test-Path -LiteralPath $npmCli)) {
    throw "npm-cli.js not found at $npmCli"
  }

  Write-Step "Running npm install in $ProjectRoot"
  Push-Location $ProjectRoot
  try {
    Invoke-External -FilePath $nodeExe -Arguments @(
      $npmCli,
      "install",
      "--no-audit",
      "--no-fund"
    ) -Operation "npm install"
  }
  finally {
    Pop-Location
  }
}

# Chặn deploy nhầm chi nhánh: .env PHẢI tồn tại và có BRANCH_ID=<số>.
function Assert-EnvBranchId {
  param([string]$ProjectRoot)

  $envFile = Join-Path $ProjectRoot ".env"
  if (-not (Test-Path -LiteralPath $envFile)) {
    throw ".env not found at $envFile. Copy .env.example -> .env and set SERVER_URL / AGENT_TOKEN / BRANCH_ID for THIS branch first."
  }

  $match = Select-String -LiteralPath $envFile -Pattern '^\s*BRANCH_ID\s*=\s*(\d+)\s*$' | Select-Object -First 1
  if (-not $match) {
    throw ".env has no 'BRANCH_ID=<number>' line. Set it to this branch's id before installing."
  }

  $branchId = [int]$match.Matches[0].Groups[1].Value
  if ($ExpectedBranchId -ge 0 -and $branchId -ne $ExpectedBranchId) {
    throw ".env has BRANCH_ID=$branchId but -ExpectedBranchId $ExpectedBranchId was requested. Fix .env (or the parameter)."
  }

  Write-Host ""
  Write-Host ">>> Deploying relay for BRANCH_ID = $branchId <<<" -ForegroundColor Yellow
  Write-Host ">>> Make sure this cashier machine really belongs to that branch! <<<" -ForegroundColor Yellow
  Write-Host ""
  return $branchId
}

function Upsert-OnStartTask {
  param(
    [string]$NodeExe,
    [string]$SupervisorJs,
    [string]$WorkingDir
  )

  # SYSTEM + onstart: relay lên ngay khi máy boot, không cần login, user thường không kill nổi.
  # Dùng cmdlet Register-ScheduledTask thay vì schtasks.exe /tr: dưới Windows PowerShell 5.1,
  # tham số /tr chứa quote lồng bị re-wrap sai khi node.exe nằm trong "C:\Program Files"
  # (schtasks nhận '/tr "C:\Program"' + argument thừa) → tạo task hỏng hoặc fail Invalid syntax.
  # Cmdlet ghi thẳng XML nên miễn nhiễm quoting của cả PS 5.1 lẫn pwsh 7.
  Write-Step "Creating task '$TaskName' -> `"$NodeExe`" `"$SupervisorJs`""

  $action = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$SupervisorJs`"" -WorkingDirectory $WorkingDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
}

function Set-TaskHardening {
  param([string]$Name)

  # Lớp resilience ngoài cùng: task tự restart khi fail, không giới hạn thời gian
  # chạy, StartWhenAvailable (trigger lỡ lúc boot vẫn chạy bù), không sợ pin.
  try {
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction Stop
    $task.Settings.Priority = $TaskPriority
    $task.Settings.ExecutionTimeLimit = "PT0S"
    $task.Settings.StartWhenAvailable = $true
    $task.Settings.DisallowStartIfOnBatteries = $false
    $task.Settings.StopIfGoingOnBatteries = $false
    $task.Settings.RestartCount = 10
    $task.Settings.RestartInterval = "PT1M"
    if ($task.Triggers) {
      foreach ($trigger in $task.Triggers) {
        try { $trigger.Delay = "PT0S" } catch { }
      }
    }
    Set-ScheduledTask -InputObject $task | Out-Null
    Write-Step "Task '$Name' -> priority $TaskPriority, restart-on-fail x10 every PT1M, no time limit, start ASAP"
  }
  catch {
    Write-Host "Warning: could not harden task '$Name': $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

try {
  Assert-Admin

  $projectRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
  $supervisorJs = Join-Path $projectRoot "supervisor.js"
  if (-not (Test-Path -LiteralPath $supervisorJs)) {
    throw "supervisor.js not found at $supervisorJs"
  }

  Write-Step "Project root: $projectRoot"

  $branchId = Assert-EnvBranchId -ProjectRoot $projectRoot
  Install-NodeIfNeeded -MsiPath $NodeMsiPath
  Install-NpmDependencies -ProjectRoot $projectRoot

  $nodeExe = Get-NodeExePath
  Upsert-OnStartTask -NodeExe $nodeExe -SupervisorJs $supervisorJs -WorkingDir $projectRoot
  Set-TaskHardening -Name $TaskName

  Write-Step "Starting task '$TaskName' now"
  Start-ScheduledTask -TaskName $TaskName

  Write-Host ""
  Write-Host "Completed successfully (BRANCH_ID=$branchId)." -ForegroundColor Green
  Write-Host "Verify:"
  Write-Host "  schtasks /query /tn `"$TaskName`" /v /fo list"
  Write-Host "  Get-Content `"$projectRoot\logs\relay.log`" -Tail 20"
  Write-Host "  Get-Content `"$projectRoot\logs\supervisor.log`" -Tail 20"
}
catch {
  Write-Host ""
  Write-Host "Setup failed." -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
