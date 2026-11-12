# Speaks each line of sentences.txt with Windows' built-in voice into
# bench/audio/NN.wav: 24 kHz, 16-bit, mono, the format the mod streams.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$audio = Join-Path $here 'audio'
New-Item -ItemType Directory -Force $audio | Out-Null
Add-Type -AssemblyName System.Speech
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$i = 0
foreach ($line in Get-Content (Join-Path $here 'sentences.txt')) {
  if (-not $line.Trim()) { continue }
  $i++
  $out = Join-Path $audio ('{0:D2}.wav' -f $i)
  $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voice.SetOutputToWaveFile($out, $format)
  $voice.Speak($line)
  $voice.Dispose()
}
"Wrote $i files to $audio"
