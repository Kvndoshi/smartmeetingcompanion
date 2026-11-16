<#
.SYNOPSIS
  Generates the synthetic two-speaker test meeting used by scripts/e2e_meeting.py.

.DESCRIPTION
  Uses the Windows built-in System.Speech voices (Zira + David) - no API keys.
  Reads fixtures/meeting_script.json and writes, into fixtures/:
    meeting.wav    ~5 minute meeting, 16 kHz mono 16-bit PCM (what the extension streams)
    s2s_en.wav     short English clip for the speech-to-speech check
    reference.txt  exact spoken text (for word error rate)

  Run from backend/:
    powershell -ExecutionPolicy Bypass -File scripts/make_test_meeting.ps1
#>
param(
    [string]$FixturesDir = (Join-Path $PSScriptRoot "..\fixtures"),
    [int]$Rate = 0,
    [int]$PauseMs = 700
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$FixturesDir = (Resolve-Path $FixturesDir).Path
$data = Get-Content (Join-Path $FixturesDir "meeting_script.json") -Raw -Encoding UTF8 | ConvertFrom-Json

$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    16000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono
)

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = $Rate
$installed = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }

function Resolve-Voice([string]$name) {
    if ($installed -contains $name) { return $name }
    Write-Warning "Voice '$name' is not installed; using the default voice."
    return $installed[0]
}

# Meeting: one PromptBuilder with a voice per speaker and a pause between turns.
$prompt = New-Object System.Speech.Synthesis.PromptBuilder
$reference = New-Object System.Collections.Generic.List[string]
foreach ($line in $data.lines) {
    $voice = Resolve-Voice ($data.voices.($line.speaker))
    $prompt.StartVoice($voice)
    $prompt.AppendText($line.text)
    $prompt.EndVoice()
    $prompt.AppendBreak([TimeSpan]::FromMilliseconds($PauseMs))
    $reference.Add("$($line.speaker): $($line.text)")
}

$meetingWav = Join-Path $FixturesDir "meeting.wav"
$synth.SetOutputToWaveFile($meetingWav, $format)
$synth.Speak($prompt)
$synth.SetOutputToNull()

# Short clip for the speech-to-speech (English -> es/fr) check.
$clip = New-Object System.Speech.Synthesis.PromptBuilder
$clip.StartVoice((Resolve-Voice $data.s2s_clip.voice))
$clip.AppendText($data.s2s_clip.text)
$clip.EndVoice()
$clip.AppendBreak([TimeSpan]::FromMilliseconds(1500))
$clipWav = Join-Path $FixturesDir "s2s_en.wav"
$synth.SetOutputToWaveFile($clipWav, $format)
$synth.Speak($clip)
$synth.SetOutputToNull()
$synth.Dispose()

$reference | Set-Content -Path (Join-Path $FixturesDir "reference.txt") -Encoding UTF8

$bytes = (Get-Item $meetingWav).Length
$seconds = [math]::Round(($bytes - 44) / 32000, 1)
$words = (($data.lines | ForEach-Object { $_.text }) -join " ").Split(" ", [StringSplitOptions]::RemoveEmptyEntries).Count
Write-Host "meeting.wav : $seconds s, $words words, $($data.lines.Count) turns"
Write-Host "s2s_en.wav  : $([math]::Round(((Get-Item $clipWav).Length - 44) / 32000, 1)) s"
Write-Host "Written to  : $FixturesDir"
