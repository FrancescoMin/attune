<#
.SYNOPSIS
  Registers or removes a zero-overhead Windows Scheduled Task that automatically
  launches Attune (in the system tray) whenever your CMF / Nothing earbuds connect.

.DESCRIPTION
  Uses an event-driven trigger on the Windows Audio event log
  (Channel: Microsoft-Windows-Audio/Operational, EventID: 65, NewState: 1 = Active)
  filtered by XPath to the paired CMF / Nothing device name.
  No background daemon or polling loop runs while the buds are disconnected (0 MB RAM, 0% CPU).

.PARAMETER Uninstall
  Removes the scheduled task.

.PARAMETER ExePath
  Optional explicit path to Attune-Portable.exe or Attune.exe.
  Defaults to dist\Attune-Portable.exe (falling back to dist\win-unpacked\Attune.exe).

.PARAMETER DeviceName
  Optional explicit Bluetooth audio device name (e.g. "CMF Buds Pro 2").
  Auto-detected from paired Bluetooth devices if omitted.
#>
param(
  [switch]$Uninstall,
  [string]$ExePath = '',
  [string]$DeviceName = ''
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Attune-CMF-AutoLaunch'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[OK] Scheduled task '$TaskName' removed." -ForegroundColor Green
  } else {
    Write-Host "[INFO] Scheduled task '$TaskName' was not installed." -ForegroundColor Yellow
  }
  exit 0
}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ExePath) {
  $portable = Join-Path $ProjectRoot 'dist\Attune-Portable.exe'
  $unpacked = Join-Path $ProjectRoot 'dist\win-unpacked\Attune.exe'
  if (Test-Path $portable) {
    $ExePath = (Resolve-Path $portable).Path
  } elseif (Test-Path $unpacked) {
    $ExePath = (Resolve-Path $unpacked).Path
  } else {
    throw "Attune executable not found in dist\. Run 'npm run dist' first or pass -ExePath."
  }
}

if (-not $DeviceName) {
  $btDev = Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue |
    Where-Object { $_.FriendlyName -match '^(CMF|Nothing)\b' -and $_.FriendlyName -notmatch 'Trasporto|AVRCP|Hands-Free' } |
    Select-Object -First 1
  if ($btDev -and $btDev.FriendlyName) {
    $DeviceName = $btDev.FriendlyName.Trim()
  } else {
    $DeviceName = 'CMF Buds Pro 2'
  }
}

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$escapedDevice = [System.Security.SecurityElement]::Escape($DeviceName)
$escapedExe = [System.Security.SecurityElement]::Escape($ExePath)
$escapedWorkDir = [System.Security.SecurityElement]::Escape((Split-Path -Parent $ExePath))

# EventID 65 in Microsoft-Windows-Audio/Operational fires whenever an audio endpoint changes state.
# NewState = 1 (DEVICE_STATE_ACTIVE), flow = 0 (eRender / Playback).
$subscriptionXml = @"
<QueryList>
  <Query Id="0" Path="Microsoft-Windows-Audio/Operational">
    <Select Path="Microsoft-Windows-Audio/Operational">*[System[Provider[@Name='Microsoft-Windows-Audio'] and (EventID=65)] and EventData[Data[@Name='DeviceName']='$escapedDevice' and Data[@Name='NewState']='1' and Data[@Name='flow']='0']]</Select>
  </Query>
</QueryList>
"@
$escapedSub = [System.Security.SecurityElement]::Escape($subscriptionXml)

$taskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Avvia automaticamente Attune nella System Tray quando si connettono le cuffie Bluetooth ($escapedDevice). Zero consumo in background.</Description>
  </RegistrationInfo>
  <Triggers>
    <EventTrigger>
      <Enabled>true</Enabled>
      <Subscription>$escapedSub</Subscription>
    </EventTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$userId</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$escapedExe</Command>
      <Arguments>--tray --mini</Arguments>
      <WorkingDirectory>$escapedWorkDir</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

Register-ScheduledTask -TaskName $TaskName -Xml $taskXml -Force | Out-Null

Write-Host "[OK] Task '$TaskName' registrato con successo!" -ForegroundColor Green
Write-Host "     Dispositivo : $DeviceName"
Write-Host "     Eseguibile  : $ExePath --tray --mini"
Write-Host "     Trigger     : Microsoft-Windows-Audio/Operational (EventID 65, NewState=1, flow=0)"
