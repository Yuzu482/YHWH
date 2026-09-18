# WPF animation clocks run on the existing UI dispatcher; no extra polling loop.
$script:transitionRunning=$false
$script:transitionDisposed=$false
$script:pendingTransition=$null
$script:activeTransition=$null
$script:applyingState=$false
$script:transitionSurface=$null

function Clear-TransitionClocks {
  foreach($property in @([Windows.Window]::WidthProperty,[Windows.Window]::HeightProperty,[Windows.Window]::LeftProperty,[Windows.Window]::TopProperty,[Windows.UIElement]::OpacityProperty)){$window.BeginAnimation($property,$null)}
  $window.Opacity=1
  if($script:transitionSurface){
    $scale=$script:transitionSurface.RenderTransform
    if($scale -is [Windows.Media.ScaleTransform]){
      $scale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleXProperty,$null)
      $scale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleYProperty,$null)
      $scale.ScaleX=1;$scale.ScaleY=1
    }
  }
}
function Apply-WindowState($Request) {
  $script:applyingState=$true
  try{
    if($Request.kind -eq 'mode'){Set-MonitorModeImmediate ([string]$Request.value)}
    elseif($Request.kind -eq 'compact'){
      if($script:displayMode -ne 'panel'){return}
      $compact.IsChecked=[bool]$Request.value
      if($Request.value){
        if($taskArea.Visibility -ne 'Collapsed'){$script:expandedHeight=$window.Height}
        $taskArea.Visibility='Collapsed';$window.MinHeight=260;$window.Height=260
      }else{
        $window.MinHeight=380;$window.Height=[Math]::Max(380,$script:expandedHeight);$taskArea.Visibility='Visible'
      }
      Limit-MonitorPosition
    }
  }finally{$script:applyingState=$false}
}
function New-TransitionAnimation([double]$From,[double]$To,[int]$Milliseconds) {
  $animation=[Windows.Media.Animation.DoubleAnimation]::new()
  $animation.From=$From;$animation.To=$To
  $animation.Duration=[Windows.Duration]::new([TimeSpan]::FromMilliseconds($Milliseconds))
  $ease=[Windows.Media.Animation.CubicEase]::new();$ease.EasingMode='EaseOut';$animation.EasingFunction=$ease
  return $animation
}
function Complete-WindowTransition {
  if(-not $script:transitionRunning -or $script:transitionDisposed){return}
  Clear-TransitionClocks
  $script:transitionRunning=$false
  $next=$script:pendingTransition;$script:pendingTransition=$null
  if($next){Request-WindowTransition $next.kind $next.value}
}
function Start-TransitionReveal {
  if(-not $script:transitionRunning -or $script:transitionDisposed){return}
  Apply-WindowState $script:activeTransition
  # Complete layout once while hidden; animating a transparent HWND size stalls WPF.
  $window.UpdateLayout()
  $script:transitionSurface=if($script:displayMode -eq 'pet'){$petSurface}else{$panelSurface}
  $script:transitionSurface.RenderTransformOrigin=[Windows.Point]::new(0.5,0.5)
  $scale=[Windows.Media.ScaleTransform]::new(1,1);$script:transitionSurface.RenderTransform=$scale
  $scale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleXProperty,(New-TransitionAnimation 0.975 1 200))
  $scale.BeginAnimation([Windows.Media.ScaleTransform]::ScaleYProperty,(New-TransitionAnimation 0.975 1 200))
  $reveal=New-TransitionAnimation 0 1 220
  $reveal.Add_Completed({Complete-WindowTransition})
  $window.BeginAnimation([Windows.UIElement]::OpacityProperty,$reveal)
}
function Request-WindowTransition([string]$Kind,$Value) {
  if($script:applyingState -or $script:transitionDisposed){return}
  $request=@{kind=$Kind;value=$Value}
  if($script:transitionRunning){$script:pendingTransition=$request;return}
  if($window.IsVisible){
    if($Kind -eq 'mode' -and $Value -eq $script:displayMode){return}
    if($Kind -eq 'compact' -and (($taskArea.Visibility -eq 'Collapsed') -eq [bool]$Value)){return}
  }
  if(-not $window.IsVisible -or -not $script:allowMotion -or -not [Windows.SystemParameters]::ClientAreaAnimation){Apply-WindowState $request;return}
  $script:activeTransition=$request;$script:transitionRunning=$true
  $script:transitionFrom=@{width=$window.Width;height=$window.Height;left=$window.Left;top=$window.Top}
  $fade=New-TransitionAnimation 1 0 70
  $fade.Add_Completed({Start-TransitionReveal})
  $window.BeginAnimation([Windows.UIElement]::OpacityProperty,$fade)
}
function Finish-WindowTransitionImmediately {
  if(-not $script:transitionRunning){return}
  $request=if($script:pendingTransition){$script:pendingTransition}else{$script:activeTransition}
  $script:transitionRunning=$false;$script:pendingTransition=$null
  Clear-TransitionClocks
  Apply-WindowState $request
}
function Set-MonitorMode([string]$NextMode){Request-WindowTransition 'mode' $NextMode}
$window.Add_Closed({
  $script:transitionDisposed=$true;$script:transitionRunning=$false;$script:pendingTransition=$null
  Clear-TransitionClocks
})
