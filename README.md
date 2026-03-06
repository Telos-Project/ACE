# ACE

## 1 - Abstract

***Game On!***

ACE, or Telos ACE, is a [G-Scene](https://github.com/Telos-Project/APInt?tab=readme-ov-file#231---g-scene)
based game engine content format, with associated adapters for certain game engines.

## 2 - Contents

### 2.1 - Components

All ACE component utilities shall have the tag "telos-ace", and their primary tag type shall
determine the type of component they represent.

Any information, or "data point", for a component not specified in its content shall be specified
using sub-fields of a "data" object embedded as a property of the component utility.

#### 2.1.1 - Scripts

ACE Scripts may be written, in principle, in any language. The content of the component utility
shall specify the code of the script, and a "language" data point specifying the language used as a
string.

The code shall be written as an [OQL Agnostic Script](https://github.com/Telos-Project/OmniQuery?tab=readme-ov-file#21136---agnostic-scripts).