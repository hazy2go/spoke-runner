#!/bin/zsh
# usage: gen2.sh outdir name "prompt"  (retries on capacity errors)
out=$1; n=$2; p=$3; d=job2_$n; mkdir -p $d; cd $d
STYLE="Art direction: polished premium mobile-game art, painterly semi-realistic sci-fi, rich lighting. No text, no letters, no logos, no watermark."
for try in 1 2 3 4; do
  codex exec --skip-git-repo-check --sandbox workspace-write -C . "Use your built-in image generation tool (do NOT write code, do NOT use Python/PIL or any script to draw). $p $STYLE Then copy the generated file into the current directory as $n.png" > log.txt 2>&1
  [ -f $n.png ] && { cp $n.png ../$out/$n.png; exit 0; }
  sleep $((try*20))
done
echo "FAILED $n" >> ../failed.txt
