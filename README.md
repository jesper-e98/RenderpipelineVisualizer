# Render Pipeline Visualizer

En interaktiv webbapp som visar **hela** vägen ett 3D-objekt tar från fil på disk till pixlar på skärmen –
buffertar, vertexlayout, shaders, pipeline state, descriptors, kommandon, vertex shader, clipping,
rasterisering, fragment shader, djuptest, blending och present – för **OpenGL 4.6**, **Vulkan 1.3** och
**DirectX 12**.

*An interactive web app that walks a 3D model through the entire rendering pipeline, from file to pixel,
for OpenGL, Vulkan and DirectX 12. UI in Swedish and English.*

## Funktioner

- **Ladda in ett eget objekt** – dra och släpp en `.obj`, `.glb`, `.gltf` (med inbäddade buffertar) eller `.stl`,
  eller välj ett inbyggt (Utah-tekanna, kub, sfär, torusknut, ikosaeder, en enda triangel).
  Blender-filer (`.blend`) går inte att läsa i webbläsaren – exportera dem från Blender via
  **File → Export → glTF 2.0** och välj **glTF Binary (.glb)**.
- **Slides med animationer** – bläddra fram och tillbaka med ← →, mellanslag, svep, eller klicka i
  pipeline-kartan längst ner. Varje slide har delsteg som byggs upp ett i taget.
- **Tre API:er** – byt mellan OpenGL, Vulkan och DirectX 12 (tangent 1/2/3). Kod, begrepp och ansvarsfördelning
  (vad du skriver / vad drivrutinen gör) byts för varje steg.
- **Två lägen** (tangent M):
  - *Verklig data* – ditt objekts riktiga siffror: bytes i vertexbufferten, MVP-matriser, clip-koordinater,
    fragment på ett pixelrutnät, djupbuffert osv. Allt räknas fram av en mjukvaru-pipeline i webbläsaren som
    följer respektive API:s konventioner (t.ex. z ∈ [−1, 1] i OpenGL, z ∈ [0, 1] och vänd Y i Vulkan).
  - *Koncept* – illustrativa animationer av idén bakom varje steg.
- **Svenska / engelska** med växlare uppe till höger.

## Kom igång

Kräver Node.js 20 eller senare.

```bash
npm install
```

```bash
npm run dev
```

Öppna sedan adressen som skrivs ut (normalt http://localhost:5173).

Övriga kommandon:

```bash
npm test          # enhetstester för pipeline-matematiken och modell-laddningen
npm run build     # typkontroll + produktionsbygge till dist/
npm run preview   # servera dist/ lokalt
```

## Publicera på GitHub Pages

Workflowen `.github/workflows/deploy.yml` bygger och publicerar sidan vid varje push till `main`.
Slå på det en gång under **Settings → Pages → Build and deployment → Source: GitHub Actions**.
Bygget använder relativa sökvägar, så det fungerar under `https://<användare>.github.io/<repo>/`.

## Struktur

```
src/
  core/        slide-motor, state, språk, cachad per-modell-data, DOM-hjälpare
  model/       inläsning (OBJ/glTF/GLB/STL), normalisering, inbyggda modeller
  pipeline/    mjukvaru-pipeline: transform, clipping, rasterisering, shading, vertexlayout
  views/       återanvändbara visualiseringar: 3D-scen med bloom, pixelrutnät, flödesdiagram, API-panel
  slides/      en fil per slide (00-intro.ts … 19-summary.ts), ordningen i slides/index.ts
  styles/      gemensam stil + slide-specifik CSS i styles/slides/
tests/         vitest-tester
```

## Lägga till en slide

1. Skapa `src/slides/NN-namn.ts` som default-exporterar `standardSlide({...})` (se `src/slides/03-layout.ts`
   som mall): titel, ingress och punkter (en per delsteg) som `L('svenska', 'english')`, en `data`- och en
   `concept`-visualisering, och en API-panel med kod för `opengl`, `vulkan` och `d3d12`.
2. Lägg till den i listan i `src/slides/index.ts`.

Visualiseringar får ett `host`-element och en `ctx` med aktuell modell, API, läge och språk, samt
`ctx.derived` (cachad vertexbuffert, mjukvarurendering m.m.) och `ctx.stage` (delad three.js-renderare).
