#!/bin/zsh
# usage: gen.sh name "prompt"
n=$1; p=$2; d=job_$n; mkdir -p $d; cd $d
STYLE="Art direction for the whole set: polished premium mobile-game art, painterly semi-realistic sci-fi, rich lighting, deep space indigo/navy base with warm cherry-red (#A55C55) and gold (#ECC100) accent lights. No text, no letters, no logos, no watermark."
codex exec --skip-git-repo-check --sandbox workspace-write -C . "Use your built-in image generation tool (do NOT write code, do NOT use Python/PIL or any script to draw). $p $STYLE Then copy the generated file into the current directory as $n.png" > log.txt 2>&1
ls -la $n.png 2>/dev/null && cp $n.png ../$n.png
