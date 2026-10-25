# Generates one WAV file per dialogue line (16 kHz, 16-bit, mono) with the Windows built-in
# text-to-speech voices listed in sample-dialogue.json. Output: server/bench/samples/line-NN.wav
# Usage (PowerShell, from the repo root):  powershell -File server/bench/make-sample-audio.ps1
Add-Type -AssemblyName System.Speech
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dialogue = Get-Content -Raw -Path (Join-Path $here 'sample-dialogue.json') | ConvertFrom-Json
$out = Join-Path $here 'samples'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$i = 0
foreach ($line in $dialogue.lines) {
  $voice = $dialogue.voices.($line.speaker)
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SelectVoice($voice)
  $file = Join-Path $out ('line-{0:D2}.wav' -f $i)
  $synth.SetOutputToWaveFile($file, $format)
  $synth.Speak($line.text)
  $synth.SetOutputToNull()
  $synth.Dispose()
  Write-Output ("{0}  {1}  {2}" -f $file, $line.speaker, $line.text)
  $i++
}
