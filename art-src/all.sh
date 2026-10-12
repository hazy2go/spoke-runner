#!/bin/zsh
cd ~/Projects/spoke-runner/art-src
T="Isolated single object, centered, on a fully transparent background (PNG with alpha channel), nothing else in frame, generous padding."
./gen.sh bg_nebula "A wide 1536x1024 deep-space backdrop: dark indigo/navy space with soft cherry-red and gold nebula clouds drifting across, scattered small stars, subtle dust, mostly dark so gameplay sprites read clearly on top. No planets, no ships." &
./gen.sh ship "Top-down view (straight from above) of a sleek small cargo starship pointing straight UP, white and graphite hull with cherry-red stripes, gold glowing twin engines at the bottom, square 1024x1024. $T" &
./gen.sh hub "Top-down view (straight from above) of a huge circular orbital hub space station: a glowing white-gold star core in the center surrounded by a rotating ring of docking arms and lights with cherry-red accents, square 1024x1024. $T" &
./gen.sh title_art "A cinematic 1536x1024 key art: a small white cargo starship with gold engine trails flying toward a giant glowing ring-shaped hub space station, with several colorful planets connected to the hub by faint glowing light-lanes like spokes of a wheel, epic space vista. Leave the left third darker and calm for UI overlay." &
wait
./gen.sh planet_ice "Top-down orthographic view of a round icy blue-white planet with frozen cracks and a thin atmosphere glow rim, perfectly circular sphere, square 1024x1024. $T" &
./gen.sh planet_gas "Top-down orthographic view of a round banded gas giant planet in amber, cream and rust bands with a storm spot, perfectly circular sphere, square 1024x1024. $T" &
./gen.sh planet_lava "Top-down orthographic view of a round volcanic lava planet, dark basalt crust with glowing orange-red magma rivers, perfectly circular sphere, square 1024x1024. $T" &
./gen.sh planet_ocean "Top-down orthographic view of a round ocean planet, deep teal and turquoise seas with swirling white clouds and small islands, perfectly circular sphere, square 1024x1024. $T" &
wait
./gen.sh planet_desert "Top-down orthographic view of a round desert planet, sand dunes in ochre and pink tones with canyons, perfectly circular sphere, square 1024x1024. $T" &
./gen.sh planet_violet "Top-down orthographic view of a round crystalline violet planet with glowing magenta crystal fields and a soft purple atmosphere rim, perfectly circular sphere, square 1024x1024. $T" &
./gen.sh asteroid_a "A single rocky grey-brown asteroid seen from above, craters and sharp edges, lit from top-left, square 1024x1024. $T" &
./gen.sh asteroid_b "A single dark metallic iron asteroid with gold mineral veins seen from above, irregular lumpy shape, lit from top-left, square 1024x1024. $T" &
wait
./gen.sh crate "A single glowing sci-fi cargo crate seen at a slight top-down three-quarter angle, graphite metal with gold trim and a cherry-red light strip, square 1024x1024. $T" &
./gen.sh fuel_pod "A single sci-fi fuel canister seen at a slight top-down three-quarter angle, glass tank with glowing gold liquid fuel inside and graphite caps, square 1024x1024. $T" &
wait
echo ALLDONE
