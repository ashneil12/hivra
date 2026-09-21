param([string]$ProgramBase64)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$program = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ProgramBase64))
$start = $program.IndexOf('function PortIncludesRdp')
$end = $program.IndexOf('try {', $program.IndexOf('function CouldMatchTermService'))
Invoke-Expression $program.Substring($start, $end - $start)
$start = $program.IndexOf('  $allPortFilters = @(')
$end = $program.IndexOf('  if ($conflicts.Count', $start)
$optimized = $program.Substring($start, $end - $start)
$original = @'
$conflicts = @(Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -ErrorAction Stop | Where-Object {
  $_.Name -ne 'Hivra-RDP-Private-Access-v1' -and (CouldMatchTermService $_)
} | ForEach-Object {
  $rule = $_
  @($rule | Get-NetFirewallPortFilter -ErrorAction Stop) | Where-Object {
    ([string]$_.Protocol -eq 'TCP' -or [string]$_.Protocol -eq '6' -or [string]$_.Protocol -eq 'Any') -and
    (PortIncludesRdp([string]$_.LocalPort))
  } | ForEach-Object { $rule.Name }
})
'@
function Get-NetFirewallRule {
  [CmdletBinding()] param($Enabled,$Direction,$Action)
  $script:rules
}
function Get-NetFirewallPortFilter {
  [CmdletBinding()] param([Parameter(ValueFromPipeline=$true)]$InputObject)
  process { if ($null -eq $InputObject) { $script:bulk } else { $InputObject.Ports } }
}
function Get-NetFirewallServiceFilter {
  [CmdletBinding()] param([Parameter(ValueFromPipeline=$true)]$InputObject)
  process { $script:calls++; $InputObject.Services }
}
function Get-NetFirewallApplicationFilter {
  [CmdletBinding()] param([Parameter(ValueFromPipeline=$true)]$InputObject)
  process { $script:calls++; $InputObject.Applications }
}
function Rule($Name,$Protocol,$Port,$Service='TermService',$App='C:\Windows\System32\svchost.exe',$Owner='') {
  [pscustomobject]@{Name=$Name; InstanceID=$Name; Owner=$Owner; Ports=@([pscustomobject]@{InstanceID=$Name;Protocol=$Protocol;LocalPort=$Port});
    Services=@([pscustomobject]@{Service=$Service}); Applications=@([pscustomobject]@{Program=$App})}
}
$script:rules = @(
  (Rule 'Hivra-RDP-Private-Access-v1' 'TCP' '3389'),
  (Rule 'package' 'Any' 'Any' 'Any' 'Any' 'package-owner'),
  (Rule 'unrelated' 'TCP' '80'),
  (Rule 'udp' 'UDP' '3389'),
  (Rule 'tcp' 'TCP' '3389'),
  (Rule 'numeric-tcp' '6' '3389'),
  (Rule 'any' 'Any' 'Any' 'Any' 'Any'),
  (Rule 'range' 'TCP' '3300-3390'),
  (Rule 'comma' 'TCP' '22,3389'),
  (Rule 'other-service' 'TCP' '3389' 'Dnscache'),
  (Rule 'other-app' 'TCP' '3389' 'Any' 'C:\Other\app.exe'),
  (Rule 'missing-service' 'TCP' '3389'),
  (Rule 'ambiguous-app' 'TCP' '3389')
)
$script:rules[11].Services = @()
$script:rules[12].Applications = @([pscustomobject]@{Program='Any'},[pscustomobject]@{Program='Any'})
$script:bulk=@($script:rules | ForEach-Object { $_.Ports })
function Fail([string]$Code) { throw $Code }
$script:calls=0
Invoke-Expression $original
$before = @($conflicts | Sort-Object -Unique)
$beforeCalls=$script:calls
$script:calls=0
Invoke-Expression $optimized
$after = @($conflicts | Sort-Object -Unique)
if (($before -join ',') -cne ($after -join ',')) { throw 'firewall_conflict_equivalence_failed' }
if (($after -join ',') -cne 'ambiguous-app,any,comma,missing-service,numeric-tcp,range,tcp') { throw 'firewall_fixture_expectation_failed' }
if ($script:calls -ge $beforeCalls) { throw 'unrelated_association_queries_not_eliminated' }
$afterCalls=$script:calls
$validBulk=$script:bulk
$invalidCases=0
foreach ($case in @('missing','duplicate','wrong-filter-id','wrong-rule-name')) {
  $script:bulk=$validBulk
  if ($case -eq 'missing') { $script:bulk=@($validBulk | Where-Object { $_.InstanceID -ne 'tcp' }) }
  if ($case -eq 'duplicate') { $script:bulk=@($validBulk)+@($validBulk[4]) }
  if ($case -eq 'wrong-filter-id') {
    $script:bulk=@($validBulk | Where-Object { $_.InstanceID -ne 'tcp' })+@([pscustomobject]@{InstanceID='wrong';Protocol='TCP';LocalPort='3389'})
  }
  if ($case -eq 'wrong-rule-name') { $script:rules[4].Name='wrong' }
  $rejected=$false
  try { Invoke-Expression $optimized } catch { if ($_.Exception.Message -ne 'rdp_firewall_filter_association_unverified') { throw }; $rejected=$true }
  $script:rules[4].Name='tcp'
  if (-not $rejected) { throw 'unverifiable_association_accepted' }
  $invalidCases++
}
[pscustomobject]@{Equivalent=$true;Cases=$script:rules.Count;InvalidAssociationCasesRejected=$invalidCases;OriginalAssociationCalls=$beforeCalls;OptimizedAssociationCalls=$afterCalls} | ConvertTo-Json -Compress
