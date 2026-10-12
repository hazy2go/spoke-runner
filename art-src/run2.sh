#!/bin/zsh
cd ~/Projects/spoke-runner/art-src
T="Top-down orthographic view of a single perfectly round planet sphere, square 1024x1024, isolated and centered on a fully transparent background (PNG with alpha channel), nothing else in frame, generous padding, soft atmosphere glow rim."
E="Isolated single object, centered, on a fully transparent background (PNG with alpha channel), nothing else in frame, generous padding, square 1024x1024."
i=0
./gen2.sh . mev_bot "Top-down view (straight from above) of a small menacing pirate drone fighter ship pointing straight UP, black and gunmetal angular hull with glowing crimson-red lights and twin red engines at the bottom, aggressive insectoid shape. $E" &
./gen2.sh . leviathan "Top-down view (straight from above) of a massive menacing alien-mechanical boss mothership pointing straight UP, wide manta-ray shape, black armor plates with glowing crimson-red core and many red turret lights, intimidating. $E" &
./gen2.sh . freighter "Top-down view (straight from above) of a large damaged grey cargo freighter ship pointing straight UP, boxy hull with orange hazard stripes, one engine sparking, distress beacon light. $E" &
wait
while IFS=$'\t' read -r key desc; do
  ./gen2.sh planets "$key" "$T Planet look: $desc." &
  i=$((i+1))
  if (( i % 4 == 0 )); then wait; fi
done < planets.tsv
wait
echo ALLDONE2
