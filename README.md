# Fieldcraft: Pine Valley

A full-screen voxel-world game with deterministic numeric seeds, deep rivers, large biome regions, mostly flat terrain, long descending cave systems, fallen forest logs, roaming pigs, textured blocks, and destructible terrain.

## Run

Install Node.js 20.19+ or 22.12+, then from this folder run:

```powershell
npm install
npm run build
```

Open `dist/index.html` directly in a browser. The generated file includes the game code, styles, and image assets, so it does not need Vite or a web server to run. For development with hot reload, run `npm run dev` instead.

## Play online

The game is published at [jjpiegames.github.io/minecraftce.github.io](https://jjpiegames.github.io/minecraftce.github.io/). GitHub Actions builds and deploys the game whenever changes are pushed to `main`.

The hosted site supports singleplayer. LAN multiplayer still requires a host to run the Node.js server described below; GitHub Pages does not host that server. The host opens a saved world, pauses, and selects **Start as LAN**. Joiners open the host's network address, select **Multiplayer**, enter the four-digit code, and select **Join World** to load directly into the shared world.

## LAN multiplayer

On the host computer, run `npm run lan`. This builds the game, starts the LAN room server, and prints the host's local network address. Allow Node.js through the local firewall if prompted. Other players on the same Wi-Fi or wired LAN should open that address in a browser, select **Multiplayer**, and enter the four-digit room code shown to the host. To open an existing singleplayer world to LAN, pause it and choose **Start as LAN**. The host must keep the server window open while playing; stopping it closes the room. Up to eight players can join.

LAN rooms share the numeric world seed, player positions, and block placement/removal. Each player keeps their own inventory, and pig behavior is simulated locally on each device.

## Play

- Desktop: enter a numeric world seed (up to 16 digits) or randomize one, then click **Enter world**. Every seed creates the same connected world with plains, woodland, highlands, desert, and tundra regions; underground caves are generated throughout the world, with some also opening at the surface, alongside descending tunnels and cliffs. Use `W A S D` to move, mouse to look, `Space` to jump or swim upward, `Ctrl` to crouch on land or sink while swimming, `Shift` to sprint, click a pig to hit it and send it fleeing or hold left mouse over a block or grass foliage to break it. Grass foliage breaks without a drop. Right-click places the selected block. Press `E` to open the inventory, drag items between slots, and use `F5` or **POV** to cycle between first- and third-person views. Use the **Music** toggle for original synthesized ambient music. Press `Esc` to pause and `R` for a new world.
- Touch: use the left pad to move, drag the right side to look, and tap the on-screen jump, hit/break, place, sprint, inventory, and pause controls.
