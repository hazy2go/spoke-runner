#!/bin/zsh
cd ~/Projects/spoke-runner/art-src
T="Top-down orthographic view of a single perfectly round planet sphere, square 1024x1024, isolated and centered on a fully transparent background (PNG with alpha channel), nothing else in frame, generous padding, soft atmosphere glow rim."
i=0
while IFS=$'\t' read -r key desc; do
  [ -f "planets/$key.png" ] && continue
  ./gen2.sh planets "$key" "$T Planet look: $desc." < /dev/null &
  i=$((i+1))
  if (( i % 5 == 0 )); then wait; fi
done < planets.tsv
wait
echo ALLDONE3
