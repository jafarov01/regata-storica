# Background song (not in git)

Put the song for the big screen here as **`background.mp3`**. It plays in every phase: full volume in the lobby and results, quieter under the effects during a match (`src/render/audio.ts`). Without the file, the generated accordion waltz (`sounds/lobby-loop.mp3`) plays in the lobby and results instead.

The file is git-ignored on purpose: the repository is public and most songs are somebody else's copyright, so committing one would redistribute it. Share it with teammates directly (AirDrop, Slack) and copy it into this folder on the scene PC.

Format: MP3 (any bitrate, mono or stereo). It loops when it ends.
