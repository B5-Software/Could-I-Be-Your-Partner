# PowerShell UI Automation tree extractor
# Uses .NET UIAutomationClient and UIAutomationTypes assemblies
# Outputs JSON with element tree: {index, type, name, value, bbox, actions}

param(
    [int]$MaxDepth = 15,
    [int]$MaxElements = 300
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$uiAutomation = New-Object System.Windows.Automation.AutomationElement
$rootElement = [System.Windows.Automation.AutomationElement]::FocusedElement

if (-not $rootElement) {
    # Fallback to desktop root
    $rootElement = [System.Windows.Automation.AutomationElement]::RootElement
}

$script:indexCounter = 0
$script:elements = @()
$script:truncated = $false

function Get-ElementInfo {
    param($element, $depth)

    if ($script:indexCounter -ge $MaxElements) {
        $script:truncated = $true
        return $null
    }

    try {
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Custom
        )

        # Build cache request for batch property retrieval
        $cacheReq = New-Object System.Windows.Automation.CacheRequest
        $cacheReq.Add([System.Windows.Automation.AutomationElement]::NameProperty)
        $cacheReq.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
        $cacheReq.Add([System.Windows.Automation.AutomationElement]::AutomationIdProperty)
        $cacheReq.Add([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
        $cacheReq.Add([System.Windows.Automation.AutomationElement]::IsEnabledProperty)
        $cacheReq.Add([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)
        $cacheReq.TreeScope = [System.Windows.Automation.TreeScope]::Element
        $cacheReq.TreeFilter = [System.Windows.Automation.Condition]::TrueCondition

        $cachedEl = $element.GetUpdatedCache($cacheReq)

        # Get properties from cache
        $name = $cachedEl.Cached.Name
        $ctrlType = $cachedEl.Cached.ControlType
        $ctrlTypeName = if ($ctrlType) { $ctrlType.ProgrammaticName } else { "Unknown" }
        $ctrlTypeName = $ctrlTypeName -replace "^ControlType\.", ""
        $autoId = $cachedEl.Cached.AutomationId
        $bbox = $cachedEl.Cached.BoundingRectangle
        $isEnabled = $cachedEl.Cached.IsEnabled
        $isOffscreen = $cachedEl.Cached.IsOffscreen

        # Skip offscreen elements (unless they're the root)
        if ($isOffscreen -and $depth -gt 0) {
            return $null
        }

        # Get value pattern
        $value = $null
        try {
            $valuePattern = $cachedEl.GetCachedPattern([System.Windows.Automation.ValuePattern]::Pattern)
            if ($valuePattern) {
                $value = $valuePattern.Cached.Value
            }
        } catch {}

        # Get actions
        $actions = @()
        try {
            $supportedPatterns = $cachedEl.GetSupportedPatterns()
            foreach ($p in $supportedPatterns) {
                $pName = $p.ProgrammaticName
                if ($pName -match "InvokePattern") { $actions += "invoke" }
                elseif ($pName -match "TogglePattern") { $actions += "toggle" }
                elseif ($pName -match "SelectionItemPattern") { $actions += "select" }
                elseif ($pName -match "ExpandCollapsePattern") { $actions += "expand" }
                elseif ($pName -match "ValuePattern") { $actions += "set_value" }
                elseif ($pName -match "ScrollPattern") { $actions += "scroll" }
            }
        } catch {}

        $idx = $script:indexCounter
        $script:indexCounter++

        $bboxObj = $null
        if ($bbox.Width -gt 0 -and $bbox.Height -gt 0) {
            $cx = [math]::Round($bbox.X + $bbox.Width / 2)
            $cy = [math]::Round($bbox.Y + $bbox.Height / 2)
            $bboxObj = @{
                x = [math]::Round($bbox.X)
                y = [math]::Round($bbox.Y)
                w = [math]::Round($bbox.Width)
                h = [math]::Round($bbox.Height)
                cx = $cx
                cy = $cy
            }
        }

        $info = @{
            index = $idx
            depth = $depth
            type = $ctrlTypeName
            name = $name
            value = $value
            automationId = $autoId
            bbox = $bboxObj
            actions = $actions
        }

        $script:elements += $info
        return $cachedEl
    } catch {
        return $null
    }
}

function Walk-Tree {
    param($element, $depth = 0)

    if ($depth -gt $MaxDepth) { return }
    if ($script:truncated) { return }

    $cachedEl = Get-ElementInfo $element $depth
    if (-not $cachedEl) { return }

    # Get children using TreeWalker
    try {
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        $child = $walker.GetFirstChild($cachedEl)

        while ($child -and -not $script:truncated) {
            Walk-Tree $child ($depth + 1)
            $child = $walker.GetNextSibling($child)
        }
    } catch {}
}

# Walk the tree
Walk-Tree $rootElement 0

# Output JSON
$output = @{
    truncated = $script:truncated
    count = $script:elements.Count
    elements = $script:elements
}

$output | ConvertTo-Json -Depth 10 -Compress
