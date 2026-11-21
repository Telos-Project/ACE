# ACE Liberty

## 1 - Abstract

ACE Liberty is an ACE component protocol.

## 2 - Contents

### 2.1 - Conventions

All ACE component utilities shall have the tag "telos-ace", and their primary tag (index 0 of the
tags list, per APInt §2.2.4) shall determine the type of component they represent.

#### 2.1.1 - Components and Content

A utility without the tag is not a component and shall be ignored by the engine entirely. It
remains part of the document, and is therefore readable by scripts, which is how a document carries
the things a scene is made *from* rather than made *of*: maps, tables of monsters and items, quest
definitions, dialogue, saved progress, and any part of a world that outlives the moment being
played.

A package containing no component anywhere beneath it is not part of the scene. Adapters shall not
build a transform for it: it is a filing system, not a place, and a large body of content would
otherwise cost a node per row.

The distinction is the document's own, and needs nothing added to APInt to express: the tag is what
marks a utility as the engine's business, and everything untagged is simply data that happens to be
kept in the same file as the scene that reads it.

#### 2.1.2 - Property Layout

A component utility's properties field shall contain up to two data objects:

- **data** — authored data points. Written by document authors and by scripts. Read by the engine.
- **state** — reflected data points. Written by the engine. Read by scripts. Never authored.

This division is normative and is referred to as the **authority rule**: the engine shall not write
to a data object except for consumable fields (§2.2.4), and no author or script shall write to a
state object. Engine writes to state are discarded from any script output.

The reconciler shall detect change by comparing only the `data`, `source`, and `content` fields of
components, and the `meta.data` field of entities. State is excluded from change detection.

Any state field not applicable to the current runtime shall be absent rather than null.

### 2.2 - Entities

Per G-Scene, an entity is a package and its components are its utilities. Entity-level properties
shall be placed in the `meta` field of the entity's properties (APInt §2.2.3), so that they apply
to the entity itself and do not bubble to its components.

    {
      "properties": {
        "meta": {
          "tags": ["enemy"],
          "data": { "position": [0, 1, 0] },
          "state": { }
        }
      },
      "utilities": { }
    }

Entity `meta.data`:

| Field | Type | Default | Meaning |
|---|---|---|---|
| position | vec3 | [0,0,0] | Translation, relative to parent entity |
| rotation | vec3 \| vec4 | [0,0,0] | Length 3 = Euler XYZ in radians; length 4 = quaternion XYZW |
| scale | vec3 \| number | [1,1,1] | A single number scales uniformly |
| space | string | "parent" | "parent", "world", "screen", or "camera" |
| enabled | boolean | true | If false, the entity and its descendants are inert and unrendered |
| visible | boolean | true | If false, the entity and its descendants are unrendered but remain simulated |
| anchor | boolean | false | XR only. Requests a persistent spatial anchor at this pose |

Entity `meta.state`:

| Field | Type | Meaning |
|---|---|---|
| position | vec3 | Resolved world-space translation |
| rotation | vec4 | Resolved world-space orientation, quaternion |
| scale | vec3 | Resolved world-space scale |
| anchored | boolean | XR only. Whether an anchor was successfully established |

Entities with `space: "screen"` interpret position as normalized viewport coordinates, with
[0,0] at the lower-left and [1,1] at the upper-right, and z as sort order. Entities with
`space: "camera"` are positioned in the active camera's frame, in metres, so an entity at
[0, -0.34, -1] sits one metre ahead of the view and slightly below its centre. Both are the
mechanism by which 2D interfaces and heads-up displays are expressed; there is no separate
interface component family.

A camera-space entity is resolved against the active camera's *entity*, not against the camera
object, so that it inherits the document's forward axis rather than the engine's. Its descendants
follow it as they would anywhere else.

Text drawn in camera space is how a document presents a heads-up display. Adapters shall not
require a host to overlay one, since an element drawn above the rendering surface intercepts the
pointer events the document needs.

The engine writes the simulated pose of a physically driven entity to `meta.state`, never to
`meta.data`. Writing to `meta.data.position` or `meta.data.rotation` on an entity carrying a
dynamic body is a teleport: the value is consumed and cleared (§2.2.4). Such a teleport preserves
the body's velocity; the `teleport` field of the body component (§2.3.8) is the form that clears
it.

An entity carrying a dynamic body is simulated in world space and is detached from its parent's
transform for as long as the body exists. Its `meta.state` therefore reports the simulated pose
rather than a pose composed through the package hierarchy, and its descendants continue to follow
it. Adapters shall not attempt to compose a simulated pose with an authored parent transform.

### 2.3 - Conventions

**Coordinates.** Right-handed, Y-up, -Z forward. Adapters targeting left-handed engines shall
convert at the boundary.

Forward is -Z for every component that has a facing: a camera looks along its entity's -Z, a
directional light shines along it, and a spot light points along it. Where the underlying engine
disagrees — and camera conventions frequently do — the adapter shall correct for it rather than
leaving the document to compensate. A camera and a light on the same entity must face the same way,
and a control scheme derived from the document's forward axis must not read inverted.

Rotation about +Y follows the right-hand rule, so increasing yaw turns from -Z toward -X, which is
a turn to the left. Increasing pitch, a rotation about +X, tilts the view up.

**Units.** Distance in meters, mass in kilograms, time in seconds, angles in radians, force in
newtons.

**Colors.** Either a 3 or 4 element array of floats in [0,1] representing linear RGB(A), or a
string in "#rrggbb" or "#rrggbbaa" form representing sRGB. Adapters shall accept both.

**Sources.** Wherever a component takes a `source`, APInt 2.1.2 permits a list of locations in
order of preference. Adapters shall try each in turn, on the basis of whether a location can be
reached rather than on what its file extension suggests, and report failure only when every
candidate has failed. The component's state shall record which candidate succeeded. This is the mechanism by which a document depending on third-party asset hosts degrades
rather than breaks, and adapters shall implement it for every component that loads an asset, not
only for models.

**References.** A field documented as a *reference* holds an APInt element path, expressed either
as a list of strings or as a period-delimited string (APInt §2.1.4). References resolve against the
document root. Where a reference field may alternatively hold a literal asset location, the
reference form shall be wrapped in an object with a single key naming the target kind, e.g.
`{ "texture": "props.crate.albedo" }`, so that plain strings are always literal locations.

**Capabilities.** The `world` component's `requires` field lists capabilities the document depends
upon. An adapter which cannot supply a listed capability shall refuse the document rather than
render it partially.

### 2.4 - Consumable Fields

A small number of data fields express one-shot commands rather than persistent state. These are
**consumable**: the engine applies the value, then deletes the field from the document. This is the
sole exception to the authority rule, and the complete set is:

| Component | Field |
|---|---|
| entity (meta) | position, rotation, scale — when the entity carries a dynamic body |
| body | impulse, torque, teleport |
| audio | play, stop, seek |
| animation | play, stop, seek |
| controller | haptic |
| display | fullscreen, capture |
| query | (the whole component, when `continuous` is false) |

No other field is consumable, and adapters shall not extend this set.

### 2.5 - Simulation Stepping

Physics shall be advanced on the fixed timestep declared by `world.data.step`, and never on a
frame's measured duration. A host which reports elapsed time accumulates it and advances by whole
steps, capping the number of steps taken in any one frame so that a stall cannot compound. A host
which reports no frame timing advances exactly one step per frame.

The consequence, and the reason for the rule, is that a document is reproducible: the same document
advanced the same number of frames produces the same state, on any adapter and at any frame rate.
Documents driven by the Dynamic Declarative Simulation Pipeline depend on this, since an AI
rewriting the simulation reference must be able to predict the effect of the rewrite.

Adapters shall disable any automatic frame-rate-driven stepping supplied by the underlying engine.

### 2.6 - Order of a Frame

An adapter shall perform the following in order:

1. Write the reserved entity (§2.5) from the current runtime, replacing whatever it held.
2. Resolve the document into its component and entity set.
3. Run `start` scripts, then `update` scripts, applying each output before the next runs.
4. Reconcile: destroy departed components, create new ones, report changes.
5. Apply and clear consumable fields.
6. Apply entity transforms and reflect resolved poses.
7. Run `onUpdate` for every live component.
8. Flush reflected state into the document.
9. Render, then advance the simulation by §2.2.5.

An entity's transform shall be established when its node is created, not deferred to step 6, since
components created in step 4 — collision bodies above all — are constructed from it.

## 2.3 - Component Reference

### 2.3.1 - world

Scene-wide settings. Exactly one per document, in the root entity. Ignored elsewhere.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| gravity | vec3 | [0,-9.81,0] | Omit or set null to disable physics simulation entirely |
| background | color \| reference | [0,0,0,1] | A color, or `{ "texture": <path> }` referencing a cube texture, which becomes the skybox and the environment. A skybox is scenery and shall never answer a query |

A background whose alpha is zero clears to nothing at all, which is what an augmented session needs:
the passthrough camera shows through wherever the document has drawn nothing. The same document on a
screen renders on black, so an augmented scene can be tried without a device.
| horizon | number | 1000 | Skybox radius |
| ambient | color | [0,0,0] | Ambient light contribution |
| fog | object | — | `{ color, near, far }` for a linear fog, or `{ color, density }` for an exponential-squared one (a fog with a density is the second) |
| step | number | 1/60 | Fixed physics timestep; see §2.2.5 |
| substeps | integer | 1 | Physics solver substeps per step |
| requires | string[] | [] | Required capabilities: "physics", "xr-vr", "xr-ar", "audio", "hands" |
| boot | object | — | Read by the host page, not the adapter: `{ title, fonts: [{ family, src, weight }], loading: { title, status, ready, background, color, muted, track, bar, titleFont, bodyFont, minimum, timeout } }`. `fonts` are loaded before the world is made; `loading` is a cover shown until it is made, and when absent the document simply starts. A page shall not impose a cover of its own |

A document with gravity (the default) is simulated by a physics solver that the host supplies; a host page loads one only for a document that asks for gravity, and a document with `gravity: null` needs none.

**state**

| Field | Type | Meaning |
|---|---|---|
| ready | boolean | All non-streaming assets in the document have resolved |
| capabilities | string[] | Capabilities the current runtime actually supplies |

### 2.3.2 - camera

Pose comes from the containing entity. A document with no enabled camera renders nothing.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| projection | string | "perspective" | "perspective" or "orthographic" |
| fov | number | 1.05 | Vertical field of view in radians, perspective only |
| size | number | 10 | Vertical extent in meters, orthographic only |
| near | number | 0.1 | |
| far | number | 1000 | |
| target | vec3 \| reference | — | World-space look-at point or entity. Overrides entity rotation while present |
| control | string | "none" | "none", "orbit", "fly", "first-person" — built-in navigation |
| speed | number | 1 | Movement rate for built-in navigation, m/s |
| viewport | vec4 | [0,0,1,1] | Normalized region of the display to render into |
| order | number | 0 | Render order for multi-camera setups; highest is composited last |
| clear | boolean | true | Whether to clear before rendering |
| xr | object | — | `{ mode, features, space }` — see below |

`xr.mode` is "vr" or "ar". `xr.features` is a list of optional session features, e.g.
"hit-test", "anchors", "planes", "hands", "light-estimation". `xr.space` is the reference space,
default "local-floor". `xr.teleport`, absent by default, asks for the runtime's own teleportation
locomotion; a document that moves its own subject shall leave it absent, or the two will contend
for the same thumbstick.

`xr.scale` is the fraction of the device's own resolution to draw at (1 is the device's choice).
`xr.near` and `xr.far` replace the camera's clipping planes while presenting: a session writes an
ordinary depth buffer, so a document that normally draws with a reversed one (§2.3.21, world `reverseDepth`)
has it put aside for the session, and its precision then depends on a near plane that is not tiny.
A controller state also carries `ray` (world space) and `local` (the same ray in the frame of the
entity the view hangs off, which is the frame a camera-space interface is laid out in). While
presenting, `world.post.finish` is not applied.

Presence of the `xr` field is a request to present this camera in an immersive session; absence
means no session is requested. Sessions are never started implicitly. Where the runtime cannot
offer one the request is simply never taken up, so the same document runs unchanged on a device
with no headset. Adapters shall leave whatever entry and exit affordance the runtime provides in
place rather than substituting their own.

A runtime may report its headset in its own reference space or in world space, and adapters shall
not pass either through untranslated. `pose` is world space and `offset` is relative to the camera's
entity, both derived by the adapter, so that a document turning about the head has a value whose
frame it can rely on. A document given a world position where it expected a rig-relative one is
thrown further from its subject the further it travels from the origin.

A reference space carries a position and a heading, and nothing else usefully. An adapter shall not
rotate one about any axis but the vertical: the position is carried in the same transform, so an
offset built from the base space discards it, and the viewer is returned to the origin on every
frame the subject is otherwise still. A document wanting a subject to look or travel up and down
should move the subject rather than tilt the space, which also spares it tilting the horizon.

While presenting, the headset reports its pose within a reference space that knows nothing of where
the document has placed its subject. The adapter shall resolve the headset against the camera's
entity, so that the document's transform is the origin the headset moves around within and
locomotion is expressed exactly as it is without a session. In a floor-relative space the headset
measures eye height itself, so a document that raises its camera for a flat view is responsible for
lowering it again while presenting.

**state**

| Field | Type | Meaning |
|---|---|---|
| supported | string[] | XR modes the runtime supports |
| presenting | boolean | An immersive session is active for this camera |
| pose | object | `{ position, rotation }` — head pose in world space, XR only |
| offset | vec3 | Head position relative to this camera's entity, XR only |
| views | object[] | Per-eye `{ position, rotation, fov }`, XR only |

### 2.3.3 - light

Direction is taken from the containing entity's forward axis (-Z). Position likewise.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| type | string | "directional" | "directional", "point", "spot", "ambient" |
| color | color | [1,1,1] | |
| intensity | number | 1 | |
| range | number | — | Falloff distance for point and spot |
| angle | number | 0.7 | Cone half-angle in radians, spot only |
| shadow | boolean \| object | false | `{ resolution, bias, near, far }`. Adapters shall register every mesh whose `shadow.cast` is not false as a caster, whichever of the light and the mesh was created first |

**state**

| Field | Type | Meaning |
|---|---|---|
| estimated | object | XR light estimation, when the "light-estimation" feature is active |

### 2.3.4 - mesh

Geometry, from one of three sources, in precedence order: `source` (a loaded model file),
`content` (manually specified geometry), or `data.shape` (a parametric primitive).

**Manual geometry** is supplied in the utility's `content` field. As a string, it is JSON of the
form `{ positions, normals, uvs, indices, colors }`, each a flat number array. As a number array,
it is a binary buffer whose layout is declared by `data.layout`.

**Heightmap terrain** is `shape: "heightmap"`, where `size` gives the horizontal extent, `elevation`
the vertical range, and `segments` the tessellation. The heights come either from a greyscale image
at `source`, or from `content` — as a string, JSON of the form `{ heights, resolution }` where each
height is a number in [0,1]; as a number array, raw RGBA samples whose grid is declared by
`data.resolution`. Columns run along +X and rows along -Z in every form, so the same terrain is
described whichever is used, and a document authored against a remote image can be tested against
generated heights.

Numeric heights shall be used at the precision given. Passing them through an eight bit image
buffer quantises them to 256 levels, which on a gentle grade is coarse enough to change the slope
the surface reports and anything a document derives from it.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| shape | string | — | "box", "sphere", "plane", "cylinder", "capsule", "torus", "ground", "heightmap" |
| elevation | vec2 | [0, size.y] | Minimum and maximum height, heightmap only |
| resolution | vec2 | — | Sample grid dimensions when heights arrive as raw content |
| size | vec3 \| number | [1,1,1] | Dimensions; interpretation per shape |
| segments | integer \| vec2 | 16 | Tessellation |
| layout | object | — | Binary content layout: `{ stride, attributes: { position: {offset, type, count}, ... } }` |
| billboard | string | "none" | "none", "y", "full" — orients toward the active camera |
| shadow | object | — | `{ cast, receive }`, both boolean, both default true |
| instances | object[] | — | Per-instance `{ position, rotation, scale }`, drawing the same mesh once for each. A tiled scene is thousands of copies of a handful of shapes, and a component apiece would be thousands of components diffed every frame to say the same thing |
| node | string | — | For loaded models, render only the named sub-node |

2D sprites are expressed as `shape: "plane"` with a material carrying a `region`. Sprite sheets
animate by patching that region.

**state**

| Field | Type | Meaning |
|---|---|---|
| loaded | boolean | |
| error | string | Present only on failure |
| bounds | object | `{ min, max }` in local space |
| nodes | string[] | Named sub-nodes of a loaded model |
| clips | string[] | Named animation clips available from a loaded model |
| materials | string[] | Named materials defined by a loaded model |

### 2.3.5 - material

Applies to the mesh component in the same entity. If an entity contains no material, a default
opaque white material is used. Materials are shared across entities by reference from
`data.maps` or by the links protocol (APInt §2.2.2).

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| color | color | [1,1,1,1] | Base color factor |
| metallic | number | 0 | |
| roughness | number | 1 | |
| emissive | color | [0,0,0] | |
| unlit | boolean | false | Bypass lighting entirely — the common case for 2D |
| blend | string | "opaque" | "opaque", "blend", "mask" |
| cutoff | number | 0.5 | Alpha threshold, mask only |
| side | string | "front" | "front", "back", "double" |
| region | vec4 | [0,0,1,1] | UV sub-rectangle — atlas and sprite-sheet addressing |
| tiling | vec2 | [1,1] | |
| offset | vec2 | [0,0] | |
| maps | object | — | `{ base, normal, metallic, roughness, emissive, occlusion }` |
| target | string | — | Named material slot of a loaded model to override |

Each value of `maps` is either a literal location string or a texture reference of the form
`{ "texture": <element path> }`.

**state**

| Field | Type | Meaning |
|---|---|---|
| loaded | boolean | All referenced maps have resolved |

### 2.3.6 - texture

An image, from `source` (a location) or `content` (manual pixel data). Manual pixel data is
supplied as a number array of raw samples in the format declared by `data.format`, with dimensions
declared by `data.size`; both are required in that case.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| format | string | "rgba8" | "rgba8", "rgb8", "r8", "rgba32f" |
| size | vec2 | — | Required for manual content |
| filter | string | "linear" | "linear" or "nearest" |
| wrap | string | "repeat" | "repeat", "clamp", "mirror" |
| mipmaps | boolean | true | |
| srgb | boolean | true | Whether to interpret samples as sRGB |
| flip | boolean | false | Flip vertically on load |
| cube | boolean | false | Treat as a cubemap. `source` is the common prefix of six face files; the adapter appends the face suffixes |
| faces | string[] | — | Explicit face file names, overriding the default suffixes |

**state**

| Field | Type | Meaning |
|---|---|---|
| loaded | boolean | |
| size | vec2 | Actual resolved dimensions |
| error | string | Present only on failure |

### 2.3.7 - text

The string to render is the utility's `content`.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| font | string \| reference | — | Font location, or reference to a texture for a bitmap font |
| size | number | 1 | Em height, in meters for world space, in normalized units for screen space |
| color | color | [1,1,1,1] | |
| align | string | "center" | "left", "center", "right": how lines sit in the plane |
| anchor | string | "center" | Which part of the text sits at the entity, as words: "center", or "top", "bottom", "left", "right" and pairs of them ("top left"). A billboard mirrors the horizontal part |
| width | number | content length | Width of the plane, in the same units as `size`. The glyphs are sized by `size`, so the plane's width does not stretch them |
| wrap | boolean | false | Break a long line to fit `width`. A newline always starts a line; the plane grows downward as lines are added |
| resolution | integer | 128 | Pixels in a line of the text's texture. 64 is plenty for text drawn at screen size |
| shadow | boolean | true | A soft dark shadow behind the glyphs |
| leading | number | 1.2 | Line height multiplier |
| billboard | string | "none" | As per mesh |
| order | integer | 0 | Draw layer, as for a mesh (section 2.3.21) |

**state**

| Field | Type | Meaning |
|---|---|---|
| loaded | boolean | Font has resolved |
| lines | integer | Lines after wrapping |
| bounds | object | `{ min, max }` of the laid-out text |

### 2.3.8 - body

Rigid-body dynamics for the containing entity. Requires the "physics" capability. An entity with a
body but no collider is simulated as a point mass.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| mode | string | "dynamic" | "dynamic", "kinematic", "static" |
| mass | number | 1 | Ignored for static and kinematic |
| velocity | vec3 | — | Linear velocity. A component given as null is left to the simulation |
| angular | vec3 | — | Angular velocity, on the same terms |
| damping | number | 0 | |
| angularDamping | number | 0 | |
| gravity | number | 1 | Per-body gravity scale |
| freeze | object | — | `{ position: [bool,bool,bool], rotation: [bool,bool,bool] }`. Anything standing taller than it is wide topples on the first edge it meets without this |
| sleep | boolean | true | Whether the body may be deactivated when at rest |
| impulse | vec3 | — | *Consumable.* Instantaneous impulse at the center of mass |
| torque | vec3 | — | *Consumable.* Instantaneous angular impulse |
| teleport | object | — | *Consumable.* `{ position, rotation }`, clears velocity |

Velocity is a standing instruction rather than a one-off. Adapters shall apply it on every frame it
is present, since a value set once is taken back by friction and by every contact, and a document
driving a body under its own power would come to a halt and never move again. They shall apply it
**after** reading the state below, or a document is handed back its own request in place of what the
simulation produced: gravity is then never visible in it, and a body told once to rise rises for
ever.

A document should not take back an axis it does not mean to control. Reading the vertical out and
handing it in again puts a value that is always a frame old into the value it came from, and the two
settle into an oscillation rather than a fall. Null is how an axis is left alone.

**state**

| Field | Type | Meaning |
|---|---|---|
| velocity | vec3 | Simulated linear velocity |
| angular | vec3 | Simulated angular velocity |
| sleeping | boolean | |
| grounded | boolean | A contact exists with a surface whose normal is within 45° of up |

### 2.3.9 - collider

Collision geometry. An entity may contain several colliders, forming a compound shape. A collider
without a body in the same entity is static.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| shape | string | "auto" | "auto", "box", "sphere", "capsule", "cylinder", "plane", "convex", "mesh", "heightmap" |
| size | vec3 \| number | — | Required unless "auto"; "auto" derives from the sibling mesh's bounds |
| offset | vec3 | [0,0,0] | Local offset from the entity origin |
| rotation | vec3 \| vec4 | [0,0,0] | Local rotation |
| trigger | boolean | false | Generates contacts but no collision response |
| layer | string | "default" | The layer this collider occupies |
| mask | string[] | — | Layers this collider interacts with; omit for all |
| friction | number | 0.5 | |
| restitution | number | 0 | |

"convex", "mesh" and "heightmap" derive from the sibling mesh geometry. "mesh" and "heightmap" are
valid only on static bodies. A sibling mesh with `shape: "heightmap"` resolves "auto" to "heightmap".

**state**

| Field | Type | Meaning |
|---|---|---|
| contacts | object[] | `{ target, phase, point, normal, impulse }` |

`target` is the element path of the other entity. `phase` is "begin", "stay", or "end". The contacts
list is rewritten each simulation step; a "begin" is guaranteed to be visible to scripts for exactly
one frame, and an "end" likewise.

### 2.3.10 - joint

A constraint between the containing entity's body and another. Requires "physics".

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| type | string | "fixed" | "fixed", "hinge", "slider", "ball", "distance", "spring" |
| target | reference | — | The other entity; omit to constrain to the world |
| anchor | vec3 | [0,0,0] | Attachment point, local to this entity |
| targetAnchor | vec3 | [0,0,0] | Attachment point, local to the target |
| axis | vec3 | [0,1,0] | Hinge or slider axis |
| limits | vec2 | — | Min and max, in radians or meters per type |
| motor | object | — | `{ target, force }` — target velocity or position and maximum force |
| stiffness | number | — | Spring only |
| damping | number | — | Spring only |
| break | number | — | Force at which the joint destroys itself |

**state**

| Field | Type | Meaning |
|---|---|---|
| force | number | Current constraint force magnitude |
| broken | boolean | |

### 2.3.11 - audio

Sound, from `source` or `content`.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| spatial | boolean | false | Position from the containing entity |
| volume | number | 1 | |
| rate | number | 1 | Playback rate |
| loop | boolean | false | |
| autoplay | boolean | false | Play once loaded, subject to gesture policy |
| distance | vec2 | [1,100] | Reference and maximum distance for spatial falloff |
| cone | vec3 | — | `{ inner, outer, gain }` for directional sources |
| play | boolean \| number | — | *Consumable.* Begin playback, optionally at the given offset |
| stop | boolean | — | *Consumable.* |
| seek | number | — | *Consumable.* |

**state**

| Field | Type | Meaning |
|---|---|---|
| loaded | boolean | |
| playing | boolean | |
| time | number | Current playback position |
| duration | number | |
| blocked | boolean | Playback is awaiting a user gesture, or no audio engine exists yet |
| source | string | Which candidate location was actually loaded |
| error | string | Why nothing is playing, when nothing is playing |

### 2.3.12 - animation

Playback of named clips supplied by a mesh in the same entity, or by `source`.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| clip | string | — | Clip name; see the sibling mesh's `state.clips`. Changing it shall stop the clip it replaces, since two clips playing at once blend into nothing |
| speed | number | 1 | |
| loop | boolean | true | |
| weight | number | 1 | Blend weight when several animation components are active |
| range | vec2 | — | Sub-range of the clip, in seconds |
| play | boolean | — | *Consumable.* |
| stop | boolean | — | *Consumable.* |
| seek | number | — | *Consumable.* |

**state**

| Field | Type | Meaning |
|---|---|---|
| playing | boolean | |
| time | number | |
| duration | number | |
| finished | boolean | True for one frame when a non-looping clip completes |

A loader commonly starts the first clip of a model itself. Which clip plays is the document's
decision, so adapters shall stop whatever arrived running.

### 2.3.13 - script

Code, from `content` or `source`. See §2.4.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| language | string | "js" | |
| mode | string | "blunt" | "blunt" or "agnostic" |
| output | string | "patch" | "patch" or "override" |
| phase | string | "update" | "start", "update", or "step" (fixed timestep) |
| order | number | 0 | Execution priority; lower runs first |
| enabled | boolean | true | |

**state**

| Field | Type | Meaning |
|---|---|---|
| error | string | Message from the most recent failure |
| runs | integer | Number of successful executions |
| duration | number | Seconds consumed by the most recent execution |

### 2.3.14 - query

A question the document asks of the engine. Scripts create or patch the data; the engine writes the
answer to state on the same frame. If `continuous` is absent or false, the engine deletes the
component after writing the result.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| type | string | "ray" | "ray", "shape", "overlap", "pick", "hit-test" |
| origin | vec3 | — | World-space origin; defaults to the containing entity's position |
| offset | vec3 | [0,0,0] | Added to the origin, so a probe can track its entity without the document rewriting the origin each frame |
| direction | vec3 | [0,0,-1] | |
| distance | number | 1000 | |
| screen | vec2 | — | For "pick", normalized viewport coordinates instead of origin/direction |
| shape | object | — | For "shape" and "overlap": `{ shape, size }` as per collider. For an overlap sphere, `size` is the radius |
| tags | string[] | — | Restrict the answer to entities carrying any of these tags (§2.2.2); omit to accept anything |
| limit | integer | 1 | Maximum hits to return; 0 for unlimited |
| continuous | boolean | false | Re-evaluate every frame rather than once |

**state**

| Field | Type | Meaning |
|---|---|---|
| hits | object[] | `{ target, point, normal, distance }`, nearest first |

`normal` is the surface normal at the point struck, in world space. A document reads the gradient
along a horizontal heading **d** from it as `-(d.x * n.x + d.z * n.z) / n.y`, which is what makes a
surface-relative rate of travel expressible without the adapter knowing anything about walking.

For `type: "overlap"`, every entity within the radius is answered rather than those along a line.
`point` is the nearest point on the other body, `distance` is how far that lies from the query
centre, and `normal` points from that point back toward the centre — so a document separates two
bodies by moving along `normal` by `radius - distance`. Where the centre lies inside the other body
there is no surface direction to report, and the normal points out through the nearest **side**
face, with `distance` reported **negative**: how far in the query has gone along that normal.
Answering zero would have a document separate by a fixed amount however deep it was, and anything
moving faster than that per frame would walk through a step at a time.

An overlap is answered from the state of the previous frame, so a document is responsible for not
moving further in one step than the body it is moving. Beyond that, following the nearest face out
of something thin can eject a body through its far side; a document that knows which way it was
travelling should retreat along that instead. The floor of a volume a body is standing inside is usually the nearest face of all, and
answering with it says the way out is downwards, which is no use to anything that walks: separating
vertically belongs to a downward probe, and an overlap answers laterally.

Adapters may answer an overlap against world bounding volumes rather than exact geometry. This is
an approximation, and a generous one for a long thin shape held at an angle.

A body that separates along the whole normal will ride up and over whatever it walks into. Using
only the horizontal part stops it instead, which is usually what is wanted, and is a decision for
the document rather than the adapter.

An unrestricted query answers for the nearest surface of any kind, which is rarely what a probe
wants: a downward ground probe will otherwise report the underside of whatever the subject is
standing beneath, and a document following that answer will place the subject on top of it. Tagging
the surfaces that a probe should accept is how a document expresses the difference between the
ground and the things resting on it.

Tags cannot separate a floor from a roof, because a platform is both: something to stand on from
above and something to walk beneath from below. A probe cast from overhead should therefore ask for
every surface it passes rather than the nearest, by setting `limit` to zero, and the document should
choose among the answers — the highest that is not further above the subject than it could climb.
Nothing overhead should count while the subject is off the ground, or it will be caught on a roof
at the top of a jump.

How far above counts as climbable is the same decision as how far up a body's own volume begins.
A body stopped by anything its shape touches cannot rise onto a step its shape is already resting
against, so the step height and the clearance beneath the body are set against one another or
neither works.

`type: "hit-test"` requires an XR session with the "hit-test" feature and ignores origin and
direction, using the session's tracked input ray or viewer pose.

### 2.3.15 - time

Engine-created. See §2.5.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| scale | number | 1 | Multiplier applied to delta; 0 pauses simulation |

**state**

| Field | Type | Meaning |
|---|---|---|
| delta | number | Seconds since the previous frame, after scale |
| unscaled | number | Seconds since the previous frame, before scale |
| elapsed | number | Seconds since the document began running, after scale |
| frame | integer | Frames elapsed |
| step | number | The fixed timestep in effect |
| now | number | Wall-clock time, milliseconds since the Unix epoch |

### 2.3.16 - display

Engine-created. One per document.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| resolution | number | 1 | Render scale relative to native |
| cursor | string | "default" | "default", "hidden", "locked" |
| fullscreen | boolean | — | *Consumable.* Request or exit fullscreen |
| capture | boolean | — | *Consumable.* Request a frame capture, delivered to state.capture |

**state**

| Field | Type | Meaning |
|---|---|---|
| size | vec2 | Drawing buffer dimensions in pixels |
| ratio | number | Device pixel ratio |
| aspect | number | |
| focused | boolean | |
| fullscreen | boolean | |
| gesture | boolean | A user gesture has occurred, unblocking audio and XR |
| locked | boolean | The pointer is captured |
| xr | object | `{ presenting, mode, features, space }` |
| fps | number | Frames per second, averaged over the last second |
| capture | string | Data URL of the most recent requested capture |

### 2.3.17 - controller

Engine-created, one per connected input device. Created on connection and destroyed on
disconnection. Every input device in ACE — keyboard, pointer, touch point, gamepad, XR controller,
XR hand — is a controller, and is read identically.

**data**

| Field | Type | Meaning |
|---|---|---|
| haptic | object | *Consumable.* `{ intensity, duration }` |
| deadzone | number | Analog magnitude below which values are reported as zero; default 0.1 |

**state**

| Field | Type | Meaning |
|---|---|---|
| device | string | "keyboard", "pointer", "touch", "gamepad", "xr-controller", "xr-hand" |
| index | integer | Distinguishes multiple devices of the same kind |
| handedness | string | "left", "right", or "none" |
| digital | string[] | Every input currently on |
| pressed | string[] | Inputs that turned on this frame. Valid for one engine tick only: a script that runs less often than the engine ticks may miss an edge, and should derive edges from `digital` against what it saw last time |
| released | string[] | Inputs that turned off this frame |
| analog | object | Input identifier to number |
| pose | object | `{ position, rotation, linear, angular }` for tracked devices, in world space |
| ray | object | `{ origin, direction }` — the device's targeting ray in world space, tracked devices only |
| local | object | `{ origin, direction }` — the same ray in the frame of the entity the view hangs off, which is the frame a camera-space interface is laid out in; XR controllers only, while presenting |
| joints | object[] | `{ name, position, rotation, radius }`, XR hands only |

**Digital identifiers.**

- keyboard: `KeyboardEvent.code` values, e.g. "KeyW", "Space", "ArrowLeft", "ShiftLeft".
- pointer: "button0" through "button4".
- touch: "contact".
- gamepad: "a", "b", "x", "y", "left-bumper", "right-bumper", "left-stick", "right-stick",
  "start", "select", "up", "down", "left", "right", "home".
- xr-controller: "trigger", "squeeze", "touchpad", "thumbstick", "a", "b", in that button order,
  and "select".
- xr-hand: "pinch", "grip".

**Analog identifiers.**

- pointer and touch: "x", "y" (normalized viewport position), "dx", "dy" (delta this frame),
  "wheel", "pressure".
- gamepad: "left-x", "left-y", "right-x", "right-y", "left-trigger", "right-trigger".
- xr-controller: "thumbstick-x", "thumbstick-y", "touchpad-x", "touchpad-y", "trigger", "squeeze".
- xr-hand: "pinch".

Tracked controllers are aliased by handedness rather than by index, since that is how a document
addresses them: `engine.controllers.xr-controller-left`. A device that reports no handedness is
aliased `none`.

**select** is the one action every kind of immersive input can make, and adapters shall report it
for all of them: a trigger pulled on a controller, a pinch of a tracked hand, and a tap on the
screen of a phone. A controller reports it alongside `trigger`, so that a document binding to
`select` needs no second binding for any of the three. A controller shall be published whether or
not there is a gamepad behind it — a phone in a session has a ray and a select and nothing else.

Analog values are in [-1,1] for axes and [0,1] for triggers and pressure. A stick pushed away from
the person reads positive on every device, which for WebXR means inverting what the runtime
reports. Adapters shall report
unknown inputs under their platform-native identifier rather than omitting them.

### 2.3.18 - terrain

A landscape too large to be a mesh: a height field read from an image, drawn in chunks that change
level of detail with the distance of the viewer. Provided by the Babylon adapter's `aceWorld.js`.

Heights, and the material weights that colour the surface, stay in files. Every script is handed the
serialised document each frame and the reconciler compares every component's data each frame, so a
document that carried a million samples would spend its frame on them. The component's `source`
is the height image, a list of locations tried in turn (§2.3). The entity carrying a terrain shall be
neither rotated nor scaled. It should carry the tag its queries select, usually `ground`, so that
scripts find the surface with a ray (§2.3.14); every chunk answers as the entity.

Samples are columns along +X and rows along -Z, as for a mesh heightmap (§2.3.4). The image is
`resolution` samples across, where `resolution` minus one is a whole number of chunks.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| size | vec2 | [1000,1000] | Extent in metres along X and Z, centred on the entity |
| elevation | vec2 | [0,100] | What the lowest and highest sample mean, in metres |
| encoding | string | "rg16" | "rg16": red is the high byte and green the low byte of a sixteen bit height. "r8": the red channel alone |
| chunk | integer | 128 | Cells per chunk edge |
| lods | object[] | see below | `{ range, step }` bands: the chunk is drawn at every `step`th sample while the viewer is within `range` metres. Default `[{700,1},{1600,2},{3400,4},{1e9,8}]` |
| layers | object | | `splat`: location of an RGBA image of weights over the whole extent, red rock, green sand, blue snow, alpha dirt, what remains grass. `grass`, `dirt`, `rock`, `sand`, `snow`: each `{ base, normal }` locations of a tiling colour and normal map |
| tile | number | 6 | Metres per repeat of the fine layers |
| rockTile | number | 9 | Metres per repeat of the rock layer, which is projected along all three axes so cliffs do not stretch |
| blend | number | 320 | Distance at which a layer has faded to its average colour |
| grassTint | color | [1,1,1] | Multiplies the grass layer |

Chunks are lit by the scene's first directional light and first ambient light, and fogged as the scene
is (§2.3.1). Rock is chosen wherever the slope is steep whatever the splat says, and snow lies only
where it is not.

A chunk's skirt hangs below each of its edges so that neighbours at different levels never show a gap.

**state**

| Field | Type | Meaning |
|---|---|---|
| loaded | boolean | The height image has been read |
| chunks | integer | Chunks in the landscape |
| live | integer | Chunks currently built |
| queued | integer | Chunks waiting to change level |
| resolution | vec2 | Samples across and down |
| error | string | Present only on failure |

### 2.3.19 - scatter

Many copies of a few models, read from a table. Provided by `aceWorld.js`.

`data.table` is a list of locations of a binary file of little-endian 32 bit floats, five to a
record: x, y, z, yaw about +Y and uniform scale, relative to the entity. The table is divided into
square chunks of `data.chunk` metres (default 256). While the viewer is within `range` of a chunk,
the chunk is drawn as one thin instance of each part of a model, and `lods` names the model for
each distance band, nearest first, so that a forest is a few hundred triangles a tree in the
distance. A chunk beyond the last range is not drawn at all.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| table | string \| string[] | — | Locations of the instance table |
| chunk | number | 256 | Chunk size in metres |
| lods | object[] | — | `{ source, range }` in increasing range; `source` is a list of locations as for a mesh |
| collide | object | — | Makes the instances solid to overlap queries (§2.3.14). A trunk, `{ radius, height, base }`, as a cylinder in metres at unit scale about each instance's origin, and optionally a `crown`, `{ radius, base, height }`, above it. Scaled with the instance. The entity must carry a tag the query selects |

Scattered instances do not answer ray or pick queries, and answer overlaps only if `collide` is given.

**state**

| Field | Type | Meaning |
|---|---|---|
| loaded | boolean | Table and models have arrived |
| instances | integer | Records in the table |
| chunks | integer | Non-empty chunks |
| live | integer | Instances currently drawn |
| queued | integer | Chunks waiting to change model |

### 2.3.20 - particles

An emitter at its entity. Emission is a standing state rather than a command, so a burst is made by
raising `emitting` for a moment, and the component keeps to the data and state split.

`source` is the sprite, a list of locations.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| capacity | integer | 300 | Particles alive at once |
| emitting | boolean | true | Whether particles are being made |
| rate | number | 60 | Particles per second while emitting |
| size | vec2 | [0.5,1.5] | Minimum and maximum size in metres |
| life | vec2 | [0.5,1.2] | Minimum and maximum life in seconds |
| speed | vec2 | [1,3] | Minimum and maximum launch speed |
| radius | number | 0.2 | Half the side of the box particles are born in |
| spread | number | 1 | Spread of launch directions |
| direction | vec3 | — | Added to the launch directions |
| gravity | vec3 | [0,0,0] | |
| color, color2 | color | | Colour at birth, chosen between the two |
| fade | color | | Colour at death |
| blend | string | "add" | "add" or "standard" |
| timeScale | number | 0.016 | Simulation seconds per frame |
| local | boolean | false | Particles move with the entity |

**state**

| Field | Type | Meaning |
|---|---|---|
| alive | integer | Particles currently alive |

### 2.3.21 - Extensions to other components

These fields are additions; a document without them behaves as before.

- **world** `fog` may be `{ color, density }`, which is exponential-squared haze, in place of `{ color, near, far }`.
  A fog colour is a display colour: materials mix fog after the gamma curve. `post` is `{ exposure, contrast, tonemap, vignette }`
  and grades every material that honours the scene's image processing; `tonemap` is `"aces"` or absent.
  The background skybox shall not write depth.
- **light** `ground` is the colour an ambient light gives to surfaces facing down.
- **text** `font` is the canvas font of the glyphs, default `bold 72px sans-serif`. The texture is sized to the plane the text is drawn on, so a long line is not squashed.
- **mesh** and **text** `order` (integer, default 0) is the layer of a translucent surface. Everything translucent in the world (the sea, 5; clouds, 8) is below the menus (10 to 20) and the heads-up display (30 to 32). Translucent surfaces are drawn far to near, measured to the middle of each one, which puts a wide panel in front of text that lies across its corner; a higher layer is drawn later, over every lower one, and only the surfaces of one layer are sorted by distance. A heads-up display is a high layer.
- **world** `post.finish` is `{ bloom: { threshold, weight, kernel, scale }, fxaa, grade: { exposure, saturation, contrast, shadows, highlights, vignette, sharpen } }`: bloom and edge smoothing, then one grading pass (a filmic tone curve in linear light, cool shadows and warm highlights as RGB multipliers, a vignette, a sharpen, and a little grain). It is applied to the active camera, and made again if the camera is replaced.
- **world** `sky: false` hides the sky (a viewer under the sea), leaving the fog's colour behind everything; `fog`, `post` and `sky` are applied in place when they alone change, so a document may change them every frame.
- **mesh / text** `order` of 10 or more makes the mesh an *overlay*: it is drawn in a layer of its own after everything else, on a cleared depth buffer, sorted among overlays by `order`. A heads-up display or a menu is an overlay; a wall between it and the viewer does not hide it, so it may be placed far from the camera and scaled up, which keeps the millimetre error of a position far from the world's origin from showing.
- **world** the sky box is drawn first and writes no depth, so geometry beyond its small box is not replaced by sky. The adapter's engine uses a reversed floating-point depth buffer unless `options.reverseDepth` is false.
- **material** `region: [u, v, width, height]` shows a window of the picture (v from the bottom); changing it at run time pans and zooms the picture.
- **light** `on` (boolean, default true) switches the light itself on or off. Switching off an entity that holds a light does not do this: a light's state is not re-read from its parents, so a room's lamps are switched with `on`.
- **query** a ray straight down at the terrain tests other ground meshes too (a roof, a floor) only when its data says `surfaces: "all"`; every other such ray is answered from the height grid alone, which is much cheaper.
- **entity** everything under an entity whose `enabled` is false is asleep: it is not drawn, and its transforms are not read again until the entity is switched on. A `terrain` or `scatter` whose entity is switched off lets go of what it built (a scatter) or stops streaming (a terrain), reports nothing pending, and answers no ground or contact queries. One switch therefore removes an island, or a building's interior, from the world's cost.
- **query** a predicate-filtered pick no longer returns a mesh that is switched off.
- **query** an `overlap` against a still mesh (not skinned, not drawn as instances) answers for its triangles and not its bounding box: the nearest point of the nearest triangle within the radius, with the normal from that point toward the query and the distance to it. A building is therefore walked round, into and under. The triangles are taken into world space once, sorted into a grid, and sorted again if the mesh moves. Skinned meshes and instanced meshes keep the bounding-box answer.
- **query** a `ray` aimed straight down at the terrain answers from the height grid, but any other ground-tagged mesh nearer the ray's start (a roof, a floor, a bridge) is tested by its triangles too, and the higher surface wins. Starting the ray just above a head therefore finds the floor under a roof and not the roof.
- **query** a `ray` aimed straight down at the terrain is answered from the terrain's height grid and not its triangles (the same answer, far cheaper).
- **mesh** `opacity` (number, default 1) is how much of it can be seen; below 1 it is drawn translucent. Changing only the opacity of a mesh does not rebuild it, so it can be animated every frame.
- **camera** asking for an immersive session (`xr`) from an origin the runtime does not trust (plain http on anything but the local machine) shall lose the headset and nothing else: the request fails into the context's errors and the camera is created.
- **animation** clips are found among those of the sibling mesh first, because every copy of a model brings groups with the same names; the scene's groups are consulted only for a mesh that brought none. While a model is loading the animation waits. `autoplay`, when true, plays the selected clip whenever it is bound or changed.

### 2.3.22 - speech

A voice. Speaking is a matter of data and state like everything else: the text is said when `revision`
changes, cutting off whatever was being said, and an empty text is silence. The adapter uses the host's
speech synthesis, so which voices exist, and how good they are, belongs to the machine.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| text | string | "" | What to say |
| revision | integer | 0 | Changing it says `text` again |
| lang | string | "en" | Language prefix of the voices to choose from |
| voice | string \| integer | — | Part of a voice's name ("Zira"), or the nth of the voices of the language |
| pitch, rate, volume | number | 1 | |
| mute | boolean | false | |

**state**

| Field | Type | Meaning |
|---|---|---|
| supported | boolean | The host can speak |
| speaking | boolean | A line is being said |
| voices | integer | Voices the host has (which may arrive after the first frame) |

### 2.3.23 - storage

A value the host keeps between visits. As with speech, writing is a revision: when `revision` changes,
`value` is stored under `key` (an empty value removes the key). The value that is held is always in
`state.value`, so a document reads what was kept from state and need hold a written value in its data for
no longer than it takes to write it. It is a string; what is in it is the document's business.

**data**

| Field | Type | Default | Meaning |
|---|---|---|---|
| key | string | — | The name it is kept under |
| value | string | "" | What to keep, when `revision` changes |
| revision | integer | 0 | |

**state**

| Field | Type | Meaning |
|---|---|---|
| available | boolean | The host lets the page keep anything (private windows may not) |
| value | string | What is held |
| revision | integer | The revision last written |

### 2.3.24 - water

The sea, seen from both sides: a surface at its entity's height, `size` across, drawn as a grid of `segments` squares (depth is
interpolated across each triangle, and across one huge quad the error at a shoreline is visible). Above it the colour comes from the
depth of water over the ground, which the adapter reads from the terrain's own height image: `shallow` over the shoals, `deep`
beyond, foam where it meets land and rolling in over the shallows, two or three layers of ripples drifting different ways (the finest
fade with distance), the sky reflected by Fresnel's rule and a glitter of sun. From below, a bright window of sky about as wide as Snell's law
allows, and beyond it `under`. Both sides take the scene's fog.

| Field | Type | Default | Meaning |
|---|---|---|---|
| size | vec2 | [40000,40000] | |
| segments | integer | 300 | Squares along a side |
| shallow, deep, under | color | | Display-space colours: over shoals, in deep water, and the water as seen from inside |
| layers | object | | `{ a, b }`: two tileable normal maps |
| terrain | object | | `{ height, size, elevation, resolution, floor, center }`: the height image, how wide it is, what 0 and 1 mean, its side in samples, the level of the sea floor past its edge, and the world x, z the image is centred on (default 0, 0) |
| terrain2 | object | | A second image of the same kind (`{ height, size, elevation, resolution, center }`) for a second island; the depth of water is read from whichever covers the point, and from the floor level where neither does |

### 2.3.25 - clouds

Clouds that are somewhere: heaps of soft puffs arranged in three dimensions, so that the viewer can fly round one, over it, or into it.
A cloud is a flat-bottomed cluster, bigger puffs low, smaller high. Each puff is a billboard shaded as a sphere lit from the sun, its edge eaten
away by noise, brighter toward the top of its cloud; they are drawn as thin instances of one quad and put in order far to near now and then so that they
blend correctly. The field is made around the viewer from a hash of where each cell is (always the same, as far as the viewer goes) and drifts with the wind
as a whole; the far cells are a few big puffs each. A puff the viewer is in or near fades out, so passing through is a thickening of the air.

| Field | Type | Default | Meaning |
|---|---|---|---|
| altitude | number | 1400 | Height of the bases |
| thickness | number | 520 | How tall the tallest clouds are |
| cover | number | 0.5 | Threshold on the cover field: higher is clearer sky |
| cell | number | 1500 | Metres between clouds, about |
| range | number | 12500 | How far out clouds are made |
| wind | vec2 | [6,2.5] | Drift in metres per second |
| seed | integer | 7 | Which sky |
| lit, shade | color | | Sunlit and shadowed colours |
| opacity | number | 1 | Greatest opacity of a puff |

## 2.4 - Scripts

### 2.4.1 - Blunt Scripts

A script with `mode: "blunt"` uses the blunt input and blunt output forms of OQL agnostic scripts.
The script's code is the body of a function of two named parameters:

| Parameter | Contents |
|---|---|
| state | JSON serialization of the complete document |
| path | JSON serialization of the script component's element path, as a list of strings |

The function returns a string, or nothing. Returning nothing, an empty string, null, or undefined
is equivalent to returning no change.

Adapters shall construct the function with these parameter names bound, so that script authors
address them directly rather than through positional argument access.

### 2.4.2 - Output Modes

`output: "override"` — the returned string is parsed as JSON and replaces the document wholesale.

`output: "patch"` — the returned string is parsed as JSON and applied to the document root as a
JSON Merge Patch (RFC 7386). Objects merge recursively; a null value deletes the field it keys;
arrays and primitives replace wholesale.

Patches are rooted at the document, not at the script's entity; the script's own path is supplied
so that it may construct a patch addressing itself.

Merge Patch cannot append to or remove from an array. Where that is required, the script must
rewrite the array in full.

### 2.4.3 - Execution

Scripts of the requested phase execute once per frame, in ascending `order`, then in document
order among equal orders. Each script's output is applied before the next script executes, so a
script observes the results of those preceding it in the same frame.

After all scripts have executed, and before reconciliation, the engine:

1. Discards any content written to a `state` object or to the reserved entity (§2.5).
2. Applies and then clears all consumable fields (§2.2.4).
3. Rewrites every `state` object and the reserved entity from the current runtime.

This ordering makes `override` safe: a script may replace the entire authored document without
destroying input, timing, or reflected state.

A script which throws shall have its error recorded in `state.error` and shall not modify the
document that frame. A thrown error shall not halt the frame or other scripts.

### 2.4.4 - Agnostic Scripts

`mode: "agnostic"` is reserved for the non-blunt form of OQL agnostic scripts, in which the
function returns an OQL script that executes against the document as a DMDB, and receives the
result as a dynamic list on its next execution. It is not yet specified here.

## 2.5 - The Reserved Entity

The root package shall contain an entity aliased `engine`, created and maintained by the engine.
Documents shall not define it; any authored content at that path is discarded on load.

It contains the `time` and `display` components, and one `controller` component per connected
device, aliased by device kind and index, e.g. `engine.controllers.gamepad-0`.

Only the `state` of these components is rewritten. Their `data` — the time scale, the cursor mode —
is authored, belongs to the document, and shall be carried across the rewrite, so that a script may
set it and have it persist.

In an XR session with the "planes" or "meshes" features, the engine additionally creates entities
under `engine.detected`, each carrying a `mesh` component with manual geometry describing the
detected surface, and entity tags identifying its semantic label where the runtime supplies one.
Detected geometry is thereby readable, queryable, and renderable by the same mechanisms as authored
geometry, and requires no component of its own.

## 2.6 - Example

A cube that falls onto a floor, is lit, and can be pushed with the spacebar.

    {
      "packages": {
        "world": {
          "properties": { "meta": { "data": { } } },
          "utilities": {
            "settings": {
              "properties": {
                "tags": ["world", "telos-ace"],
                "data": {
                  "gravity": [0, -9.81, 0],
                  "background": "#101018",
                  "requires": ["physics"]
                }
              }
            }
          }
        },
        "camera": {
          "properties": {
            "meta": { "data": { "position": [0, 3, 8] } }
          },
          "utilities": {
            "view": {
              "properties": {
                "tags": ["camera", "telos-ace"],
                "data": { "target": [0, 0, 0], "control": "orbit" }
              }
            }
          }
        },
        "sun": {
          "properties": {
            "meta": { "data": { "rotation": [-0.9, 0.5, 0] } }
          },
          "utilities": {
            "light": {
              "properties": {
                "tags": ["light", "telos-ace"],
                "data": { "type": "directional", "intensity": 2, "shadow": true }
              }
            }
          }
        },
        "floor": {
          "properties": {
            "meta": { "data": { "position": [0, -1, 0] } }
          },
          "utilities": {
            "mesh": {
              "properties": {
                "tags": ["mesh", "telos-ace"],
                "data": { "shape": "box", "size": [20, 0.5, 20] }
              }
            },
            "collider": {
              "properties": {
                "tags": ["collider", "telos-ace"],
                "data": { "shape": "auto" }
              }
            }
          }
        },
        "crate": {
          "properties": {
            "meta": { "data": { "position": [0, 5, 0] } }
          },
          "utilities": {
            "mesh": {
              "properties": {
                "tags": ["mesh", "telos-ace"],
                "data": { "shape": "box", "size": 1 }
              }
            },
            "surface": {
              "properties": {
                "tags": ["material", "telos-ace"],
                "data": { "color": "#c08040", "roughness": 0.8 }
              }
            },
            "collider": {
              "properties": {
                "tags": ["collider", "telos-ace"],
                "data": { "shape": "auto" }
              }
            },
            "body": {
              "properties": {
                "tags": ["body", "telos-ace"],
                "data": { "mode": "dynamic", "mass": 2 }
              }
            },
            "push": {
              "content": "const s = JSON.parse(state); const k = s.packages.engine.packages.controllers.utilities['keyboard-0']; if (!k || !k.properties.state.pressed.includes('Space')) return; return JSON.stringify({ packages: { crate: { utilities: { body: { properties: { data: { impulse: [0, 6, 0] } } } } } } });",
              "properties": {
                "tags": ["script", "telos-ace"],
                "data": { "language": "js", "mode": "blunt", "output": "patch" }
              }
            }
          }
        }
      }
    }
