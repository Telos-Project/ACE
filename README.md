# ACE

## 1 - Abstract

***Write Once, Render Anywhere***

ACE, or Telos ACE, is an [APInt](https://github.com/Telos-Project/APInt) based game engine content
format, with associated adapters for certain game engines.

## 2 - Contents

#### 2.1 - G-Scene

G-Scene is an APInt mask which allows "entities" to be used in place of "packages", and
"components" to be used in place of "utilities".

It is intended to be used for entity-component systems, and is supported by ACE.

### 2.2 - Components

All ACE component utilities shall have the tag "telos-ace", and their primary tag type shall
determine the type of component they represent.

Any information, or "data point", for a component not specified in its content shall be specified
using sub-fields of a "data" object embedded as a property of the component utility.

#### 2.2.1 - Scripts

ACE Scripts may be written, in principle, in any language. The content of the component utility
shall specify the code of the script, and a "language" data point specifying the language used as a
string.

The code shall be written as an [OQL Agnostic Script](https://github.com/Telos-Project/OmniQuery?tab=readme-ov-file#21136---agnostic-scripts).