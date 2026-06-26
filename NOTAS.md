# AKX Cloud — Notas técnicas y decisiones

> El detalle y el **porqué** de cada fix. Este archivo **no** se carga en cada sesión
> (a diferencia de `CLAUDE.md`); el `CLAUDE.md` remite aquí cuando hace falta el detalle.

---

## Chat — pre-flights deterministas (detalle)

Para frases muy comunes no se confía en que el modelo elija la tool correcta: se
resuelven directamente contra la BD, sin llamar a Ollama.

- **Comandos compuestos** ("ábreme X y Y", "crea X y copia Y y borra Z"): va el PRIMERO de todos los pre-flights (los demás resuelven 1 sola acción y hacen `return`, así que solo ejecutaban la primera orden). Parte el mensaje por conectores (" y ", comas, "luego", "además"…), parsea cada segmento a una acción (abrir/crear/copiar/mover/renombrar/eliminar — `parsearSegmento`) y soporta verbo repartido (la "Y" de "abre X y Y" hereda el verbo previo, `"carry"`). Soporta destinos implícitos ("...y muévelas **ahí**" → última carpeta creada/usada en el mensaje, vía `ctx.ultimaCarpeta`). Modos de ejecución: si el compuesto es SOLO de "abrir/leer" (se solapa con consultas tipo "muéstrame las facturas de enero y febrero", que NO son comandos), exige que **todos los objetivos resuelvan**; si alguno no, NO intercepta y deja pasar al flujo normal. Si hay alguna acción de crear/mover/copiar/borrar/renombrar, la intención de comando es inequívoca y se ejecuta **best-effort** (cada parte por su cuenta, avisando con ⚠️ de la que falle) en vez de caer al modelo (que dejaba el trabajo a medias). Un comando de 1 solo segmento nunca se ve afectado.
- **Resolución fuzzy de nombres** (`resolverArchivo` y `resolverCarpeta`): si la búsqueda exacta por substring (`ILIKE`) no encuentra nada, se comparan los nombres reales por similitud de Levenshtein (`similitud`, umbral 0.6) y se devuelven los más parecidos (hasta 5) como **sugerencias** con `sugerencia: true`. NO se auto-resuelve nunca: el caller muestra "**¿Querías decir alguno de estos?**" con la lista para que el usuario elija (la elección se completa vía `pendientesAclaracion`, igual que una aclaración normal). Tolera erratas ("nustras armas" → "nuestras armas"). Solo se activa en el camino de fallo, así que no afecta al flujo normal. El encabezado de la pregunta lo decide `cabeceraAclaracion(sugerencia)`: "¿Querías decir…?" para sugerencias por parecido vs "Hay varias coincidencias, ¿cuál quieres?" para varias coincidencias exactas; el mensaje completo lo arma `mensajeAclaracion`.
- **Borrados masivos**: distingue "borra todo" (`borrar_todo`, incluida la raíz), "borra todas las carpetas" (`borrar_todas_carpetas`, con su contenido, sin tocar lo suelto en la raíz) y "borra todos los archivos/ficheros" (`borrar_todos_archivos`, sin tocar carpetas).
- **Restaurar TODA la papelera** ("restaura/recupera todos los archivos/ficheros", "restaura toda la papelera"): sin este pre-flight, el modelo no tenía ninguna tool de "restaurar todo" y "resolvía" la frase con `vaciar_papelera` — la acción opuesta (provocó pérdida real de datos: "restaura todos los ficheros" vació la papelera). Se añadió `restaurar_todo` (uno a uno con `restaurarArchivo` para que aplique el sufijo "(restaurado)" en colisiones) y se remarcó en ambas tools que son opuestas.
- **Listado combinado**: "lista/pásame todo lo que tengo" (archivos + carpetas), con soporte para acotar a una carpeta concreta o solo la raíz. Devuelve tablas paginadas (`tablaArchivos`/`tablaCarpetas`, ver "Paginación de listados en el chat").
- **¿Qué hay en la papelera?**: el prompt de facturas sesgaba al modelo hacia esas tools; se resuelve aquí con `listar_papelera`.
- **Existencia/ubicación de un archivo** ("¿tengo/hay/existe... archivo X?", "dónde está/busca el archivo X"): comprobación instantánea con `buscar_archivos`. Sin esto, el modelo a veces "comprobaba" escaneando con OCR (lento; en servidores sin GPU podía tirar el proceso). La respuesta incluye botón "Abrir" por coincidencia.
- **Abrir/mostrar una factura** ("abre/muéstrame factura_X"): lee de BD vía `obtener_factura`, nunca relanza OCR. Patrón del identificador: `\bfacturas?(?:[\d_-]\w*)?\b` (exige separador antes del sufijo); con el patrón laxo anterior "abre facturajpg.png" se trataba como nombre de factura.
- **Abrir/mostrar/leer un archivo NORMAL** ("lee/muestra/ábreme X"): lee el contenido con `leerTextoArchivo` sin pasar por el modelo; respuesta con botón "Abrir". "abre"/"abrir" se metió al pre-flight (`VERBO_ABRIR`) porque el modelo no seguía de forma fiable que "abrir" = "leer/mostrar". Antes de leer en crudo, si el archivo ya tiene factura escaneada en BD devuelve el resumen markdown en vez del texto plano.
- **Palabras prohibidas como nombre** (`STOPWORDS_NOMBRE`: `todo`, `eso`, `mi`, `la`, `el`...): sin esta lista, "muestra todo lo que tengo" se interpretaba como "lee un archivo llamado 'todo'" en vez de caer en el pre-flight de listado (que va DESPUÉS en el código).
- **Totales de varias facturas nombradas** ("totales de factura_01 y factura_02"): se llama `totales_facturas` con el array, en vez de abrir solo la primera.
- **Ranking de ventas con periodo** ("qué se vende más en julio", "producto más vendido"...): el modelo pequeño a veces escupía el JSON de argumentos como texto sin llamar a la tool. Se resuelve con `ventas_top` parseando mes por nombre y año. No captura producto concreto ni rankings de cliente.
- **Listado de facturas de un periodo** ("facturas de abril", "facturas de 2026"): LISTA las facturas concretas (vía `listarFacturas`/`listadoFacturasMd`) con botón "Abrir"; distinto de `ventas_top`/`totales_facturas`. Se excluye si además pide totales/ranking.
- **Borrar UN archivo/carpeta concreto** ("borra el archivo X"): el modelo casi nunca llamaba a `eliminar_archivo`/`eliminar_carpeta`; se resuelve con el mismo `resolverArchivo`/`resolverCarpeta` que las tools reales.
- **Crear una nota/archivo de texto** ("créame una nota llamada X.md con esto: ..."): extrae nombre y contenido y llama a `crearArchivoTexto` directamente (el modelo intentaba *buscar* un archivo aún inexistente).
- **Restaurar vs. borrar definitivamente de la papelera**: acciones opuestas que el modelo confundía. Se distingue por verbo (restaura/recupera/saca → `restaurar_archivo`; borra/elimina/quita + "papelera" → `borrar_permanente`).
- **Búsqueda semántica por tema** ("resume lo que tengo sobre X"): se detecta el tema tras "sobre"/"de"/"acerca de" y se llama `buscar_semantica`.
- **Verbos con pronombre enclítico y tildes**: todos los verbos se comparan sobre una versión del mensaje **sin tildes** (`quitarTildes`, NFD + strip de diacríticos) con patrones que aceptan el pronombre pegado (`borra(?:r|lo|la|los|las)?`...); el nombre capturado conserva las tildes originales (`grupoOriginal`). Así "bórralo todo" casa igual que "borra todo".

## Chat — bucle de herramientas (refuerzos)

Máx 15 iteraciones: llama Ollama → si hay `tool_calls` → ejecuta → repite. `temperature: 0`, `keep_alive: 30m`.

- **Parser de respaldo de tool calls**: si el modelo escribe las llamadas como texto JSON en `content`, se extraen con un escáner de llaves balanceadas y se ejecutan igual.
- **Remapeo de nombres alucinados** (`remapearNombreTool`): `<verbo>_facturas?` → `<verbo>_archivo`, `borrar` → `eliminar` (una factura es un archivo normal, no hay tools específicas).
- **Resolución flexible de nombres** (`resolverArchivo`/`resolverCarpeta`): por nombre/leaf-name en todas las carpetas, con fallback archivo↔carpeta y fallback a nombre suelto si el modelo antepone "/" a algo que no es ruta real. Varias coincidencias → `necesita_aclaracion` con opciones reales.
- **Bypass de aclaración**: la lista de opciones se construye en el servidor. Se recuerda en memoria (`pendientesAclaracion`, por usuario, TTL 5 min) qué tool/args se pedían, para completarlo en el turno siguiente si el usuario responde con la opción ofrecida.
- **Bypass de resumen**: si TODAS las tools de una iteración devuelven `resumen: string`, se retorna ese markdown directo sin otra llamada al modelo (evita reformateos, `$` en vez de `€`, datos inventados). En facturas y en todas las operaciones de archivos/carpetas/papelera (`resumen: "Hecho."`).

## Chat — analítica de facturas (`ventas_top`, `totales_facturas`, `clientes_top`)

Las tres aceptan un **filtro flexible** y devuelven markdown con € (bypass): `facturas` (nº o nombre; matching con límites de dígito para que "1" no case con "10"), `cliente`, `emisor`, `producto` (solo `ventas_top`), `mes`/`anio` o `desde`/`hasta`, `orden`. Si se nombran facturas no escaneadas, se escanean al vuelo (`asegurarFacturasEscaneadas`) antes de agregar (excepto `clientes_top`). Los filtros de texto usan `unaccent()` en ambos lados del `ILIKE` (migración `HabilitarUnaccent`). El filtro base excluye facturas cuyo archivo está en la papelera (`a."eliminadoEn" IS NULL`). `clientes_top` agrupa por `f."cliente"` y suma `f."total"`, sin JOIN con `lineas_factura`.

Las celdas de texto libre de estas tablas (cliente/emisor/producto/descripción) pasan por `celdaMd` (colapsa saltos de línea, neutraliza `|`, acota a 80 chars) para que un valor mal extraído por el modelo pequeño —p. ej. un `cliente` con nombre+email+teléfono pegados— no rompa la estructura de la tabla markdown.

## Chat — leer_archivo

`leerTextoArchivo` (`archivos.service.ts`) acepta texto plano directo, y para PDF/DOCX/imágenes **reutiliza `archivo.textoExtraido`** (el texto ya extraído al subir vía pdf-parse/mammoth/OCR) en vez de decodificar el binario como UTF-8. Antes rechazaba todo lo que no fuera texto. Para imágenes, lo que se lee es la descripción generada al subir (OCR o descripción manual).

## Chat — tools con bypass (markdown preconstruido, € server-side)

- `escanear_factura` → OCR (deepseek) + extracción JSON forzada con Ollama → guarda en BD → markdown. Rechaza con 422 en vez de inventar si no hay importes ni número/fecha/emisor reales (`soloSiFactura`; ver "No inventar facturas").
- `obtener_factura` → resuelve con `resolverArchivo` (maneja ambigüedad/no-encontrado) y lee de BD, sin re-escanear.
- `ventas_top` → ranking de productos (GROUP BY sobre `lineas_factura`).
- `totales_facturas` → totales (nº, subtotal, IVA, total) filtrados.

`resumenFacturaMd` (chat y `.md` de resumen) usa `##` y el título incluye el nombre del archivo junto al número (`## Factura 2026-2003 — factura_03.pdf`).

### No inventar facturas a partir de imágenes que no lo son
El `SCHEMA_FACTURA` ya NO marca campos como `required`: con la decodificación restringida de Ollama, exigir todos los campos forzaba al modelo a inventar emisor/cliente/importes cuando el texto era una foto sin factura. Además, antes de extraer hay un **gate** `pareceFacturaConImportes(contenido)`: si el contenido no tiene señales de factura, no se llama a la IA y se trata como `no_factura`. Y al detectar `no_factura` se borra cualquier factura inventada que se hubiera guardado antes para ese archivo.

## Chat — abrir archivo desde el chat

Cuando una tool/pre-flight resuelve archivos concretos, `chatear()` devuelve `archivos: {id, nombre}[]`. El front (`pages/inicio/inicio.ts`) muestra un botón "Abrir `<nombre>`" por archivo. La ventana se abre en blanco **en el momento del clic** (antes de pedir el blob) para que el navegador no la bloquee como pop-up.

## Chat — paginación de listados en el chat

Para listados largos, `chatear()` puede devolver tablas paginadas además del markdown:
- `tablaFacturas` / `tablaArchivos`: traen la **1ª página** (20 filas) + `pagina`/`totalPaginas`/`total`/`limite` + `filtro` (facturas) o `carpeta` (archivos). El frontend pide las páginas siguientes a los endpoints REST normales (`GET /api/facturas`, `GET /api/archivos`) reenviando ese filtro/carpeta, **sin** volver a pasar por el modelo.
- `tablaCarpetas`: trae TODAS las filas (las carpetas de un usuario son pocas) y el frontend pagina **en memoria**.

El front (`inicio.ts`/`inicio.html`) las pinta como tablas con controles ← Página X de Y →; al cambiar de página de facturas/archivos sustituye las filas del mensaje (`ChatService.actualizarMensaje`) tras pedir la página vía REST.

## Chat — tabla clicable de aclaración

Cuando `resolverArchivo`/`resolverCarpeta` devuelven varias `opciones` (coincidencias exactas o sugerencias por parecido), `chatear()` ya armaba el texto markdown (`mensajeAclaracion`, lista con guiones) — ahora además devuelve `tablaAclaracion: {titulo, sugerencia, limite, filas: {etiqueta, valor}[]}` con las MISMAS opciones, para no tener que escribir el nombre a mano. `titulo` es el encabezado (`cabeceraAclaracion`, "¿Querías decir...?" / "¿cuál quieres?") y sustituye al texto plano cuando hay tabla, igual que con `tablaArchivos`/`tablaCarpetas`/`tablaFacturas`.

Construcción centralizada en `respuestaAclaracion(opciones, sugerencia, acciones, extra?)`: hay ~9 puntos en `chatear()` que antes devolvían `{ respuesta: mensajeAclaracion(...), acciones }` a mano; todos pasan por este helper para no desincronizar el texto y la tabla. `filaAclaracion` mapea cada opción (string para carpetas, `{nombre,carpeta}` para archivos) a `{etiqueta, valor}` — `valor` es lo que se manda al pulsar.

El front (`inicio.ts`): pulsar una fila llama `seleccionarAclaracion(valor)`, que reusa el mismo camino que escribir y enviar el texto a mano (`enviarTexto`, extraído de `enviar()`). Esto funciona SIN tocar el backend porque `pendientesAclaracion` ya comparaba el siguiente mensaje del usuario contra las opciones ofrecidas (ver "Resolución fuzzy de nombres" arriba) — la tabla es solo un atajo de UI para no escribir el nombre, no un mecanismo nuevo de selección. Paginación en memoria igual que `tablaCarpetas` (el backend manda todas las opciones, como mucho 5 por la cascada fuzzy o todas las coincidencias exactas).

---

## OCR y descripción de imágenes (`extraccion.service.ts`) — cascada de 3 pasadas

`ocrImagen()` usa una cascada "ligero primero" (los dos primeros son modelos Ollama configurables; el tercero es CPU pura):

1. **Normalización a PNG** (`aPng`, sharp): TODA imagen se reconvierte a PNG antes de mandarla a Ollama. Sin esto, **WEBP** hacía fallar la decodificación en llama.cpp (y en GPU llegaba a tirar el proceso de Ollama).
2. **1ª pasada — granite3.2-vision** (`OLLAMA_CAPTION_MODEL`): VLM ligero (~2.4GB). Transcribe el texto si lo hay o describe la foto si no, en una sola llamada. El prompt fuerza descripción **siempre en español**.
3. **¿Parece factura con importes?** (`pareceFacturaConImportes`): símbolos de moneda / palabras clave (factura, IVA, total…) o muchos dígitos → escala a la 2ª pasada. Si no, se queda con granite (sin pagar la pasada lenta).
4. **2ª pasada — deepseek-ocr** (`OLLAMA_OCR_MODEL`): OCR especialista, la transcripción más fiel de tablas/importes. Solo para lo que parece factura. Si falla/alucina, se conserva granite. Su salida puede traer tablas HTML; `limpiarTablasHtml()` las pasa a texto plano con `|`, consistente con pdf-parse.
5. **¿Resultado pobre?** (`pareceResultadoPobre`): vacío, "meta-descripción" (habla SOBRE la estructura citando NOMBRES de campos en vez de valores) o negación de texto ("no hay texto...") sin nada útil detrás (<15 palabras) → 3ª red. Cuidado con falsos positivos: una descripción real puede empezar "La imagen presenta..." o terminar "No hay texto presente en la imagen"; por eso la meta-descripción se caza por frases concretas y la negación solo cuenta si el resto es corto.
6. **3ª red — Tesseract.js** (`ocrConTesseract`, worker singleton `createWorker("spa")`): OCR clásico por CPU, sin alucinaciones. Preprocesado (`prepararParaTesseract`: gris + normalización + reescalado a ancho mínimo 2000px) y **dos pasadas** (`PSM.AUTO` + `PSM.SPARSE_TEXT`) concatenadas: en pruebas reales `AUTO` se saltaba filas de tablas con bordes y `SPARSE_TEXT` las recuperaba pero perdía precisión en otros datos; ningún modo gana siempre, así que se quedan los dos y la IA de extracción escoge el dato correcto.
7. **Español garantizado** (`asegurarEspanol`/`pareceIngles`/`traducirAlEspanol`): si el resultado tiene 2+ palabras inglesas típicas, se traduce con `OLLAMA_MODEL` antes de guardar.

Si `OLLAMA_OCR_MODEL == OLLAMA_CAPTION_MODEL`, la 2ª pasada se desactiva sola (máquinas con un solo VLM). Reparto: granite clasifica/describe barato, deepseek afina facturas, Tesseract entra solo cuando ningún VLM dio algo aprovechable. (Se comprobó que ningún modelo pequeño iguala a deepseek en fidelidad de OCR, y que deepseek alucina ante fotos sin texto.)

`pareceBucleDegenerado()` descarta la basura de un modelo solo-OCR ante imagen sin texto (bucle repitiendo `<table:tr><td>…` o `None`). Juzga el contenido **tras quitar el HTML**, y la regla "menos de 3 palabras → basura" solo se aplica si el texto original TENÍA etiquetas (deepseek emite esas etiquetas también para tablas legítimas; una respuesta corta SIN etiquetas es pobre por otra razón).

En GPU de 8GB, deepseek-ocr (6.7GB) no entra entero (corre parcial en CPU, ~2 min/imagen) — pero solo se invoca en imágenes que parecen factura. Todo en segundo plano.

### Describir una imagen a mano (`PATCH /api/archivos/:id/descripcion`)
Ya **no** hay modal obligatorio al subir. Con la cascada, una foto sin texto se describe automáticamente al subir. El endpoint queda para corregir/afinar a mano; lo que se guarde se reindexa para RAG (`indexarTexto`, combinado vía `combinarContenido`, que omite repetir el OCR si ya está contenido en la descripción). Escanear manualmente algo que no es factura ya no copia `textoExtraido` dentro de `descripcionManual` (solo guarda la pista real del usuario).

---

## Auto-escaneo de facturas al subir

Al subir PDF/imagen, además del RAG, `ctrlSubir` dispara `autoEscanearArchivo` en segundo plano:
1. Si es PDF/imagen, se escanea con `escanearFactura(..., { soloSiFactura: true })`.
2. Guardia: solo persiste la factura si la extracción parece factura (líneas o importes > 0).

Para facturas subidas antes de esta función: "escanea todas las facturas" en el chat (o nombrarlas, que se auto-escanean al consultarlas).

---

## Limitaciones conocidas (detalle)

- **Modelo del chat**: servidor con GPU usa `qwen2.5-coder:14b` (function calling fiable). `qwen2.5:3b` es poco fiable; `qwen2.5-coder:7b` (cabe en 8GB) es mejor pero aun así falla en frases muy directas (borrar archivo/carpeta concreto, crear nota, restaurar vs. borrar de papelera) — de ahí los pre-flights. El modelo pequeño también mezcla campos en la extracción de facturas (p. ej. nombre+email+teléfono en `cliente`).
- **"Copia/mueve X a LA CARPETA Y"**: con la palabra "carpeta" antes del destino, el modelo no llama a ninguna tool de forma consistente (incluso con el 7b). Decir la ruta directa ("a /Y" o "a Y") sí funciona. Sin pre-flight aún.
- **"Lee X" con contenido muy corto**: a veces solo confirma "lo he leído" en vez de mostrar el contenido trivial; con contenido más rico sí lo resume.
- **PDFs escaneados (sin capa de texto)**: `pdf-parse` no hace OCR; solo las imágenes pasan por la cascada de visión. Para un PDF puramente escaneado habría que rasterizar las páginas a imagen antes del OCR (pendiente).
- **Auto-escaneo al subir**: consume cómputo de OCR+IA por cada PDF/imagen, aunque la guardia `soloSiFactura` no guarde los que no son factura.
- **GPU pequeña (8GB)**: deepseek-ocr corre parcial en CPU (~2 min/imagen); no bloquea la subida (segundo plano). Tesseract siempre en CPU.
