# Dot-sourced into the monitor's STA UI thread. No additional process or network.
foreach($name in @('petSurface','panelSurface','petDrag','panelDrag','petOpen','petMenuButton','petLabel','petDetail','petCount','petFace','petOrb','eyeLeft','eyeRight','petSmile','petBadge','toPet','closeMonitor')){Set-Variable -Name $name -Value $window.FindName($name)}
$script:displayMode='panel'
$script:panelWidth=600
$script:panelHeight=520
$script:petLeft=[Windows.SystemParameters]::WorkArea.Right-336
$script:petTop=[Windows.SystemParameters]::WorkArea.Bottom-126
$script:petStatus=[pscustomobject]@{state='offline';label='Pi 正在连接';detail='等待网关状态';accent='#E4BD7B';count='?'}
$script:animationKey=''
$script:allowMotion=$true

function Limit-MonitorPosition {
  $left=[Windows.SystemParameters]::VirtualScreenLeft
  $top=[Windows.SystemParameters]::VirtualScreenTop
  $right=$left+[Windows.SystemParameters]::VirtualScreenWidth
  $bottom=$top+[Windows.SystemParameters]::VirtualScreenHeight
  $window.Left=[Math]::Max($left,[Math]::Min($window.Left,$right-$window.Width))
  $window.Top=[Math]::Max($top,[Math]::Min($window.Top,$bottom-$window.Height))
}
function Set-PetStatus($Pet) {
  $script:petStatus=$Pet
  $petLabel.Text=[string]$Pet.label
  $petDetail.Text=[string]$Pet.detail
  $petDetail.ToolTip=[string]$Pet.detail
  $petCount.Text=[string]$Pet.count
  $theme=Get-StateTheme ([string]$Pet.state)
  $brush=[Windows.Media.BrushConverter]::new().ConvertFromString($theme.accent)
  $petBadge.Background=[Windows.Media.BrushConverter]::new().ConvertFromString($theme.tint)
  $petSmile.Stroke=$brush
  $eyeLeft.Background=$brush;$eyeRight.Background=$brush;$petCount.Foreground=$brush
  $petOpen.ToolTip="$($Pet.label) · $($Pet.detail) · 点击展开"
  [Windows.Automation.AutomationProperties]::SetName($petOpen,"Pi 宠物：$($Pet.label)，展开监控面板")
  $motion=$script:allowMotion -and [Windows.SystemParameters]::ClientAreaAnimation
  $key="$($Pet.state)/$script:displayMode/$motion"
  if($key -ne $script:animationKey){
    $script:animationKey=$key
    $petFace.BeginAnimation([Windows.UIElement]::OpacityProperty,$null)
    $petFace.Opacity=1
    if($motion -and $script:displayMode -eq 'pet' -and $Pet.state -in @('running','waiting')){
      $pulse=[Windows.Media.Animation.DoubleAnimation]::new()
      $pulse.From=0.35;$pulse.To=1
      $pulse.Duration=[Windows.Duration]::new([TimeSpan]::FromSeconds(1.2))
      $pulse.AutoReverse=$true;$pulse.RepeatBehavior=[Windows.Media.Animation.RepeatBehavior]::Forever
      $petFace.BeginAnimation([Windows.UIElement]::OpacityProperty,$pulse)
    }
  }
}
function Set-MonitorModeImmediate([string]$NextMode) {
  if($NextMode -eq 'pet'){
    if($script:displayMode -eq 'panel'){$script:panelWidth=$window.Width;if(-not $compact.IsChecked){$script:panelHeight=$window.Height}}
    $compact.IsChecked=$false
    $panelSurface.Visibility='Collapsed';$petSurface.Visibility='Visible'
    $window.ResizeMode='NoResize';$window.MinWidth=320;$window.MinHeight=100;$window.Width=320;$window.Height=100
    $window.Left=$script:petLeft;$window.Top=$script:petTop
  }else{
    if($script:displayMode -eq 'pet'){$script:petLeft=$window.Left;$script:petTop=$window.Top}
    $petSurface.Visibility='Collapsed';$panelSurface.Visibility='Visible'
    $window.MinWidth=520;$window.MinHeight=380;$window.Width=[Math]::Max(520,$script:panelWidth);$window.Height=[Math]::Max(380,$script:panelHeight)
    $window.ResizeMode='CanResizeWithGrip'
    Show-Tasks
  }
  $script:displayMode=$NextMode
  Limit-MonitorPosition
  Set-PetStatus $script:petStatus
}
$dragHandler={param($sender,$eventArgs)
  Finish-WindowTransitionImmediately
  $window.Left+=$eventArgs.HorizontalChange;$window.Top+=$eventArgs.VerticalChange
  Limit-MonitorPosition
}
$petDrag.Add_DragDelta($dragHandler);$panelDrag.Add_DragDelta($dragHandler)
$petOpen.Add_Click({Set-MonitorMode 'panel'})
$toPet.Add_Click({Set-MonitorMode 'pet'})
$closeMonitor.Add_Click({$window.Close()})
$window.Add_PreviewKeyDown({param($sender,$eventArgs)if($eventArgs.Key -eq 'Escape'){Set-MonitorMode 'pet';$eventArgs.Handled=$true}})
$petMenu=[Windows.Controls.ContextMenu]::new()
$petMenu.Style=$window.FindResource('PetMenu')
$menuExpand=[Windows.Controls.MenuItem]::new();$menuExpand.Header='展开监控';$menuExpand.Add_Click({Set-MonitorMode 'panel'})
$menuPin=[Windows.Controls.MenuItem]::new();$menuPin.Header='置顶';$menuPin.IsCheckable=$true;$menuPin.IsChecked=$window.Topmost
$menuPin.Add_Click({$pin.IsChecked=$menuPin.IsChecked})
$menuMotion=[Windows.Controls.MenuItem]::new();$menuMotion.Header='轻微动画';$menuMotion.IsCheckable=$true;$menuMotion.IsChecked=$true
$menuMotion.Add_Click({$script:allowMotion=$menuMotion.IsChecked;if(-not $script:allowMotion){Finish-WindowTransitionImmediately};Set-PetStatus $script:petStatus})
$menuExit=[Windows.Controls.MenuItem]::new();$menuExit.Header='退出监控（任务继续）';$menuExit.Add_Click({$window.Close()})
foreach($item in @($menuExpand,$menuPin,$menuMotion,$menuExit)){$null=$petMenu.Items.Add($item)}
$petSurface.ContextMenu=$petMenu
$petMenu.Add_Opened({$menuPin.IsChecked=$window.Topmost})
$petMenuButton.Add_Click({$petMenu.PlacementTarget=$petMenuButton;$petMenu.IsOpen=$true})
$window.WindowStartupLocation='Manual'
$window.Left=[Windows.SystemParameters]::WorkArea.Left+([Windows.SystemParameters]::WorkArea.Width-$window.Width)/2
$window.Top=[Windows.SystemParameters]::WorkArea.Top+([Windows.SystemParameters]::WorkArea.Height-$window.Height)/2
. (Join-Path $PSScriptRoot 'transitions.ps1')
Set-MonitorMode $Mode
