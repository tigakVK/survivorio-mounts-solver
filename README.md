# Survivor.io Mount Components Solver

Enter the mount components you own and get the layout that completes the most rows,
or the highest total value, on the Electric Scooter, Tech Hoverboard, Doomsteed or a custom board.

**Live:** https://tigakvk.github.io/survivorio-mounts-solver/

A rewrite of the fan-made solver at survivorio-mounts-solver.pages.dev, keeping its piece artwork.

## Scoring rules

- A row counts only when every cell in it is filled.
- A piece adds its tier value (Red 7, Orange• 6, Orange 5, Purple• 4, Purple 3, Blue 2, Green 1)
  only if all of its cells sit in complete rows. Otherwise it is filler.
- Pieces rotate but do not mirror, so L and J are different pieces.

## What the page does

- An exact solver: it searches every layout. When it says "Best possible layout", that has
  been proven. If time runs out, it says a better layout may exist and offers a longer search.
- Hints that tell you how many more pieces of which shape would complete another row.
- Shareable links: the mount, pieces and priority are stored in the URL.
- Tap a piece to add one and its − to remove one.
- Undo (also Ctrl+Z), keyboard entry on the piece grid, a phone layout, and saving the board as an image.
- Everything runs in your browser. Nothing is sent anywhere.

## Development

`index.html` is built from `src/page.html` and `src/solver.js`:

```
node build.js
```

The solver is a branch-and-bound search that runs in a Web Worker. Run the checks with:

```
node test/stress.js   # checks overlaps, row counts, values and inventory use on random cases
node test/speed.js    # timing on random real-mount inventories
node test/bench.js    # 120 harder cases on the real mounts, both priorities
```

Two colouring rules prune the search. On a checkerboard, every piece but the T covers two
cells of each colour, so the T count is constrained. With rows (or columns) coloured in
stripes, an L or J always covers 3 + 1 while squares and bars cover a multiple of 4 more of
one colour, so the L + J count is constrained too.
