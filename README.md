# Inspección de Activos (PWA offline)

App web instalable para registrar activos en campo, 100 % offline después de la primera carga. Sitio estático (HTML + CSS + JS, sin build) pensado para GitHub Pages. La especificación completa está en `BRIEF_App_Inspeccion_Activos.md`.

**Estado: v0.3.6 — plan v0.3 completo: F0 (proyectos), F1 (captura rápida), F2 (edificios), F3 (plantilla e importación), F4 (exportación para IA), F5 (reporte PDF) y F6 (pulido, temas y proyecto de prueba).** Sobre la base v0.2 (registro, fotos, audio, exportación ZIP, respaldo) se agregan proyectos, código de valuador, paquete de proyecto y la migración segura de los datos existentes. Verificado en Chromium de escritorio con pruebas automatizadas (migración v1→v2 con datos reales de v0.2.2, fallo simulado a mitad de la migración, aislamiento entre proyectos, paquetes y restauración de respaldos v1/v2). **Sin probar aún en dispositivo real:** cámara, micrófono, compartir y modo avión (ver pruebas manuales abajo).

## Estructura

```
index.html  styles.css  manifest.webmanifest  sw.js  .nojekyll
js/    app.js (rutas, ajustes, edificios) · assets.js (formulario, lista, departamentos) · data.js (contratos de datos)
       projects.js (proyectos, paquete de proyecto) · migrate.js (pantalla de migración v1→v2) · camera.js (cámara rápida, beta)
       buildings.js (lista con estados y formulario de edificio) · bldg-schema.js (columnas del Excel, listas, unidades)
       bldg-import.js (plantilla e importación de edificios) · xlsx.js (lector/escritor .xlsx mínimo sobre fflate)
       ai-export.js (ZIP para IA: estructura, índice, README_IA) · ziputil.js (ZIP, SHA-256) · export.js (pantalla Exportar, respaldo)
       report.js (reporte de avance) · pdf.js (generador de PDF mínimo, Helvetica WinAnsi) · demo.js (Proyecto Test)
       photos.js · audio.js · export.js · db.js (IndexedDB) · csv.js · version.js
css/   photos.css · audio.css · export.css      vendor/ fflate.esm.js (ZIP, vendorizado)
icons/ iconos PNG (any, maskable, apple-touch)
tools/ make-icons.ps1 · check-precache.mjs
edificios_ejemplo.csv
```

Todos los nombres de archivo van en **minúsculas**: GitHub Pages distingue mayúsculas y un solo error en la lista de precaché impide que el service worker se instale. Antes de cada publicación:

```bash
node tools/check-precache.mjs
```

## Probar en local

```bash
python -m http.server 8080
```

Abre `http://localhost:8080` (localhost cuenta como contexto seguro, el service worker funciona).

## Publicar en GitHub Pages

1. Crea un repositorio en GitHub (p. ej. `inspeccion-activos`) y sube estos archivos a la raíz de la rama `main`.
2. En el repositorio: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `/ (root)` → Save**.
3. Espera ~1 minuto. La app queda en `https://USUARIO.github.io/inspeccion-activos/`.
4. Todas las rutas de la app son relativas, así que funciona dentro del subdirectorio del repo.

## Instalar la PWA

- **Android (Chrome):** abre la URL **con internet** una vez → menú ⋮ → *Instalar app*. Ábrela desde el ícono y prueba en modo avión.
- **iPhone (Safari 16.4+):** abre la URL en Safari → Compartir → *Añadir a pantalla de inicio*. Abre siempre desde el ícono. iOS limita más el almacenamiento y puede borrarlo si no se usa la app durante semanas; exporta con frecuencia.

## Publicar una versión nueva

1. Cambia la versión en **dos** sitios: `VERSION` en `sw.js` y `APP_VERSION` en `js/version.js` (el script `check-precache.mjs` falla si no coinciden).
2. Si agregaste archivos nuevos, añádelos a `PRECACHE` en `sw.js`.
3. `node tools/check-precache.mjs`, commit y push.
4. En el teléfono, al abrir la app aparece el aviso **"Hay una nueva versión — Actualizar"**. También: Ajustes → *Buscar actualización*. La app nunca se actualiza sola a mitad de un registro.
5. Para forzar: cerrar la app por completo y reabrir, o en Chrome → Configuración del sitio → Borrar datos (**¡borra los registros!**; exporta antes).

## Precarga de edificios con Excel (v0.3 F3)

En **Edificios → Plantilla y exportación a Excel**:
- **⬇ Plantilla vacía** (`plantilla_edificios_{proyecto}.xlsx`): hoja *Edificios* con las 33 columnas del Excel de levantamiento (mismo orden; encabezados con las unidades del proyecto), listas desplegables (las del Excel, Aux_List para *HVAC Type* con `INDIRECT` y los valores agregados en el proyecto), validación de números y %, encabezado fijo; hoja *Instrucciones* y hoja oculta *Listas*.
- **⬇ Edificios a Excel**: lo mismo con los edificios del proyecto (sirve para revisar o editar en la PC y volver a importar).

**⬆ Importar Excel** acepta la plantilla llena, **el archivo fuente directamente** (mismo formato, p. ej. *Allison Brugge.xlsx*) o un CSV:
- Las columnas se reconocen por su encabezado (sin importar orden, saltos de línea ni unidades); las desconocidas se listan y se ignoran. Las unidades se detectan en los encabezados (Square Feet / Square Meters).
- Se leen los valores calculados de las fórmulas; si la fórmula es solo aritmética (`=12*95.5*10.7639`) también se guarda como operación. Una fórmula sin valor calculado (archivo nunca guardado en Excel) se avisa y la celda se omite.
- **Vista previa** antes de importar: nuevos / se actualizan / sin cambios / filas con error; filas sin código o con código repetido; valores fuera de lista (con sus filas, opción de agregarlos a las listas del proyecto); celdas omitidas (números inválidos, YES/NO mal escritos, valores no permitidos en ISO Code / Fire Protection / HVAC Category).
- Edificios con el mismo código: **completar solo campos vacíos** (predeterminado: no pisa lo capturado en campo), **sobrescribir** con el archivo o **solo agregar nuevos**. Lo importado queda *Pendiente* hasta que se capture algo en campo.
- `.xls` (Excel 97-2003) y `.xlsb` no se leen: guardar como `.xlsx`.

## Reporte de avance en PDF (v0.3 F5)

Exportar → **📄 Compartir reporte** (o *Descargar PDF*), y en Edificios el botón **📄 Reporte** junto a la barra de avance. `avance_{proyecto}_{AAAAMMDD-HHmm}.pdf` (A4) con:
- Resumen: edificios inspeccionados / total (con barra inspeccionado-en proceso-pendiente), activos (hoy, por exportar), fotos y notas de voz, registros por revisar.
- Tabla de edificios: estado, fotos, voz, activos, campos llenos.
- Activos por departamento, por edificio y piso, y por día.
- Listas: activos sin foto, sin nota (ni texto ni voz), con fotos pero sin foto de placa, y edificios sin foto.

Se comparte con la hoja de compartir del teléfono (WhatsApp, Teams, Outlook, Drive): a diferencia del ZIP, Android sí permite compartir PDF desde la app. Sin conexión funciona igual (el PDF se genera en el teléfono, sin librerías externas).

## Pulido, temas y proyecto de prueba (v0.3 F6)

- **Proyecto Test**: en la primera instalación (sin proyectos) se crea "Proyecto Test" (marcado DEMO) con 5 edificios (uno inspeccionado, uno en proceso), 6 departamentos, 10 activos (`B1-TS-A001`…) con fotos y placas legibles dibujadas por la app, una copia y avisos de ejemplo. Sirve para practicar todo antes de ir a campo. Proyectos → *Borrar proyecto de prueba* lo elimina con todos sus datos; *Cargar proyecto de prueba* lo vuelve a crear. Si la creación se interrumpe, se rehace al abrir la app. Los usuarios que ya tienen datos no lo reciben automáticamente.
- **Temas**: Automático (como el teléfono), Claro, Oscuro y Modo sol (máximo contraste). Botón en la barra superior (cicla los cuatro) y en Ajustes. La barra de estado del teléfono sigue el color del tema.
- **Diseño**: íconos SVG uniformes (barra inferior, tema, proyecto), logo propio, botones secundarios en tono suave para que destaque la acción principal, saludo con fecha en Inicio, cuatro indicadores (incluye edificios listos), botón flotante "+" que aparece al bajar en la lista, avisos debajo de la barra superior (no tapan el proyecto ni los botones).
- **Respaldo por proyecto**: en Exportar (*Solo este proyecto* / *Todos*) y en cada tarjeta de Proyectos (*Respaldo*). Se guarda la fecha del último respaldo.
- **Espacio**: cada proyecto muestra cuánto ocupan sus fotos y audios (Proyectos y Exportar).
- **Recordatorio**: en Inicio, si hay ≥ 25 activos (o alguno de hace más de 48 h) sin respaldo ni exportación, aparece un aviso con acceso a Exportar (se puede posponer).
- **Ayuda** reescrita como guía rápida de primeros pasos, captura, edificios, exportación y consejos de campo.
- Corrige: en la primera visita con service worker la app se recargaba sola una vez (podía interrumpir el arranque); campos ocultos con `hidden` que seguían visibles (fechas en Exportar).

## Formato del CSV de edificios

Exactamente 2 columnas con encabezados `BLDG #` y `BLDG NAME` (mayúsculas/espacios no importan).

```csv
BLDG #,BLDG NAME
B-01,Edificio Administrativo
B-05,"Taller de Mantenimiento, Anexo"
```

- Separador `,` o `;` (se detecta solo). Acepta BOM UTF-8, comillas, espacios extra y acentos.
- Si el archivo no es UTF-8 (Excel en español guarda en ANSI/Windows-1252) se reinterpreta automáticamente.
- Códigos `BLDG #` duplicados (sin distinguir mayúsculas): se avisa y se conserva la primera fila.
- Al importar con una lista existente se elige **Reemplazar** o **Fusionar**.
- *Exportar CSV* en Edificios descarga `edificios.csv` (UTF-8 con BOM).
- Para dar la misma lista a todos los inspectores, compartan el mismo CSV. `edificios_ejemplo.csv` es solo de prueba.

## Modelo de datos (resumen)

- `projects`: un registro por proyecto (nombre, cliente, planta, unidades, **código de valuador de este teléfono**, `status` `active` | `archived`, `last_context`). El proyecto activo está en `settings.active_project`.
- `buildings` (clave uuid, código único por proyecto), `departments` (`{project_id}|{KEY}`) y `lists` (valores agregados por el usuario, F2) llevan `project_id`.
- `assets`: un registro por activo, con `project_id` y `building_id` (`status` `draft` | `saved`). El borrador se autoguarda en cada cambio; el `seq` se asigna al guardar por primera vez.
- `blobs`: fotos (`photo`), miniaturas (`thumb`), audios (`audio`) y trozos de grabación en curso (`audiochunk`). Los módulos de medios nunca escriben el registro del activo; `photos[]`/`audios[]` se arman al exportar.
- Contexto recordado por proyecto en `projects.last_context`. Un activo está "por exportar" si nunca se exportó o se editó después (`updated_at > exported_at`).

## Proyectos y migración (v0.3)

- Cada proyecto tiene sus edificios, departamentos, activos y exportaciones. El proyecto activo se ve siempre en la barra superior; tocarlo abre **Proyectos** (crear, editar, usar, archivar, reactivar). Archivar no borra nada.
- **Código de valuador** (2–3 letras): se pide al crear el proyecto y va en los IDs de activo (`B1-GA-A001`, fase F1). Cada valuador del mismo proyecto usa uno distinto.
- **Paquete de proyecto** (`proyecto_{nombre}.json`): proyecto + edificios + departamentos + listas, sin fotos, activos ni código de valuador. Un coordinador lo comparte y los demás lo importan en Proyectos → *Importar paquete*: todos quedan con el mismo id de proyecto y los mismos ids de edificio. Importarlo de nuevo solo agrega lo que falte.
- **Migración desde v0.2:** al abrir la versión nueva con datos anteriores aparece *Actualización de datos*: 1) descargar respaldo (formato v0.2, se puede restaurar incluso en la versión anterior); 2) actualizar. Todo pasa a "Proyecto 1". La actualización es una única transacción: si falla, la base queda exactamente como estaba; las fotos y audios no se reescriben. Además se guarda una copia interna (`_v1_backup`) de edificios, departamentos y contexto.
- **Respaldo completo** (Exportar): incluye todos los proyectos. Restaurar un respaldo v0.2 lo carga en el proyecto activo; uno v0.3 agrega proyectos/edificios que falten y fusiona activos por id (gana el más reciente).

## Captura rápida de activos (v0.3 F1)

- **ID del activo** `B1-GA-A001`: edificio + código de valuador + consecutivo por edificio (por proyecto y valuador). Se asigna al guardar; nunca se reutiliza un número. Si se cambia el edificio de un activo **no exportado**, recibe un ID nuevo del edificio nuevo (el anterior queda en `previous_display_ids`); si ya se exportó, conserva su ID y se anota `moved_from_building_code`. Los activos migrados de v0.2 reciben su ID al definir el código de valuador (sin marcarse como "por exportar").
- **Guardar y nuevo** (botón principal): confirmación verde a pantalla completa con el ID + vibración, y el formulario nuevo muestra la franja **"Anterior guardado"** (ID, fotos, audios, aviso *sin foto*) con *Abrir* y *Copiar*. Conserva edificio, piso y departamento. **Guardar y salir** vuelve a la lista con la fila resaltada.
- **Nuevo edificio** desde el selector de edificio del activo (código sugerido B{n+1}); queda en el proyecto marcado `source: 'field'`.
- **Copiar activo**: desde la franja "Anterior" o desde un activo guardado. Crea un borrador con la misma ubicación (se cambia en el formulario) y, a elección, notas, audios y fotos (por defecto solo notas). Guarda `copied_from`; las fotos/audios copiados llevan `copied: true` y `_copia` en el nombre al exportar.
- **Fotos**: botones grandes **📷 Foto** y **🔎 Placa**, y *Galería*. Normal: lado largo 3072 px, JPEG 0,88. **Placa**: el JPEG original sin recomprimir (o 4096 px/0,92 si no es JPEG). HEIC/WebP se convierten a JPEG; las capturas de pantalla PNG se mantienen. En el visor se marca cada foto como General / Placa / Detalle; la línea *Sugeridas* indica cuáles faltan (no es obligatorio). Al exportar: `foto_02_placa.jpg`.
- **Cámara rápida (beta)**, en Ajustes → Cámara: varias fotos sin salir de la app, con modo Foto/Placa y linterna si el teléfono la ofrece. En Android usa la resolución completa del sensor (ImageCapture); en iPhone es un cuadro de video, por eso para placas conviene la cámara del sistema (siempre disponible).
- **Voz**: botón grande con **Pausa / Seguir** y **Terminar**; la duración no cuenta las pausas. Formato preferido `.m4a` (AAC) si el navegador lo graba; si no, `.webm` (Opus).
- **Lista**: miniaturas grandes, ID en negrita, filtros rápidos (Todos, Hoy, Sin foto, Sin nota, Por exportar, Copias), búsqueda por ID, botón flotante **+**.
- **Modo sol** (Ajustes → Pantalla): alto contraste para trabajar al aire libre.

## Edificios (v0.3 F2)

- El formulario refleja las 33 columnas del Excel de levantamiento (A–AG), agrupadas en secciones plegables con avance (p. ej. *Construcción 3/5*): Identificación, Geometría, Áreas, Construcción, Riesgo y sostenibilidad, Servicios y **Valores de gabinete** (columnas redondeadas H, J, L, M, P, R: opcionales, normalmente de la precarga u oficina). Ningún campo es obligatorio.
- **Listas** iguales a las del Excel; *Otro valor* agrega un valor (en mayúsculas) disponible para todo el proyecto (store `lists`). **HVAC: tipo** depende de la categoría con las listas de *Aux_List* (HEATING ONLY 11, HEATING AND COOLING 5, COOLING ONLY 4, NO → N/A).
- **Medidas**: área, perímetro y altura aceptan una operación (`45.5*10.5 + 85*108.5`, coma o punto decimal, `x` como multiplicación) en la unidad del botón (m/ft, m²/ft²). Se guarda la operación, el valor y su unidad, y se muestra la conversión a la unidad del proyecto. La unidad elegida se recuerda por proyecto.
- Año acepta `1980` o `1960-1990`; *Niveles + sótanos* es texto (`1 + MEZZANINE`); `%` se captura 0–100 (se exporta como fracción, igual que el Excel).
- Fotos, notas de voz y notas generales por edificio (mismos módulos que los activos; `blobs.asset_id` = id del edificio).
- **Estados**: *Pendiente* (nada capturado en campo; la precarga no cuenta), *En proceso* (alguna foto, audio, nota o campo editado), *Inspeccionado* (botón *Marcar inspeccionado*, exige ≥ 1 foto y avisa qué campos faltan sin bloquear; si se borran todas las fotos vuelve a *En proceso*). La lista muestra contadores que funcionan como filtros, barra de avance, búsqueda y por edificio: fotos, audios, activos y campos llenos.
- Exportar ZIP incluye `edificios/{CÓDIGO}/edificio.json` (campos en unidades del proyecto + medidas originales con su operación), fotos, audios y `notas.txt`, y `edificios.csv` con las 33 columnas en el orden y encabezados del Excel más columnas de la app. El respaldo completo incluye datos y medios de los edificios.

## Formato del ZIP exportado (v0.3 F4, para procesar con IA)

`inspeccion_{proyecto}_{códigoValuador}_{AAAAMMDD-HHmm}_parte{n}de{total}.zip`

```
README_IA.md      instrucciones para la IA: qué es, cómo leerlo, IDs, fotos/placas, copias, avisos, unidades
indice.json       todos los registros de la exportación con rutas a sus archivos y la parte donde está cada uno
activos.csv       un activo por fila (ID, ubicación, notas, nº fotos/audios, etiquetas, avisos, copia, GPS, carpeta, parte)
edificios.csv     33 columnas del Excel de levantamiento (unidades del proyecto) + estado, conteos, notas, carpeta, parte
archivos.csv      un archivo por fila (ruta, parte, dueño, tipo, etiqueta, copia, mime, bytes, fecha)
manifest.json     archivos de ESTA parte con SHA-256 y tamaño
B1_job-shop/                         una carpeta por edificio: {CÓDIGO}_{nombre}
  B1_edificio.json  B1_notas.txt  B1_foto_01_general.jpg  B1_audio_01.m4a
  activos/B1-GA-A001/                una carpeta por activo
    B1-GA-A001.json  B1-GA-A001_notas.txt  B1-GA-A001_foto_01_placa.jpg  B1-GA-A001_audio_01.m4a
```

- Todo nombre de archivo empieza con el ID de su registro (único aunque se aplane el ZIP). Sufijos de foto: `_placa`, `_general`, `_detalle`, `_copia`.
- Cada registro trae `warnings`: `sin_foto`, `sin_nota`, `sin_placa`, `copia_sin_fotos_propias`.
- **Alcance**: *incremental* (lo nuevo o editado desde la última exportación; predeterminado), *completo*, *un edificio* o *rango de fechas*. Los activos borrados por el valuador después de haberse exportado se informan en `indice.json → deleted` en la siguiente exportación.
- **Partes**: tamaño máximo por destino (20 MB correo, 200 MB, 500 MB, 1 GB WhatsApp/Teams/Drive). Un edificio con sus activos va completo en una parte si cabe; si no, se reparte registro por registro. Cada parte trae el índice completo.
- Antes de exportar, la pantalla avisa cuántos activos van sin foto, sin nota o sin foto de placa, y cuántos edificios sin foto o sin marcar como inspeccionados (enlaces a la lista filtrada). No bloquea.
- Compartir: en iPhone el ZIP se comparte directo; en Android, Chrome no permite compartir ZIP desde una app web: *Descargar* y adjuntarlo desde WhatsApp/Teams/Outlook (*Documento → Descargas*) o subirlo en Drive.
- El respaldo completo (`respaldo_*.zip`) no cambia: se restaura desde Exportar → *Restaurar respaldo*.

## Transcribir las notas de voz (escritorio)

La app solo graba los audios. Para transcribirlos en tu PC (Whisper local, español) usa `tools/transcribir_audios.py`: toma los ZIP exportados y devuelve una copia con el campo `transcript` de cada audio rellenado, más `transcripciones.csv`. Instrucciones y requisitos en `tools/README_transcribir.md`.

## Pruebas manuales en el S21 Ultra — Fase 1

1. Abrir la URL en Chrome con internet → *Instalar app*.
2. Abrir desde el ícono; escribir el nombre en Ajustes.
3. Activar **modo avión**, cerrar la app por completo (deslizar), reabrir: debe cargar y mostrar el nombre.
4. Importar `edificios_ejemplo.csv` y, además, un CSV guardado desde Excel (con `;` y acentos) → los acentos deben verse bien.
5. Ajustes → almacenamiento persistente debe decir *Sí*.

## Pruebas manuales en el S21 Ultra — Fases 2–6

1. Registrar 10 activos en modo avión; cerrar la app por completo y reabrir: todo sigue y el contexto (edificio/piso/departamento) se recuerda.
2. **Tomar foto** abre la cámara nativa; 20 fotos en un activo; zoom sobre una placa de datos legible. **Agregar de galería** con capturas de pantalla.
3. Con la cámara abierta, forzar el cierre de Chrome: al volver debe existir el borrador.
4. Grabar 5 audios en modo avión, reiniciar la app y reproducirlos. Cerrar la app grabando: al reabrir debe avisar que recuperó la nota.
5. Exportar 50 activos con fotos: abrir el ZIP en Windows; `activos.csv` en Excel con acentos correctos; probar *Compartir*.
6. Crear respaldo, borrar datos del sitio y restaurar.
7. iPhone (Safari 16.4+): mismo flujo; audio sale como `.m4a`.

## Pruebas manuales — v0.3 F0 (proyectos y migración)

1. **Con datos de v0.2 en el teléfono** (no borres nada): actualizar la app → aparece *Actualización de datos* con el conteo de activos, fotos y audios. *Descargar respaldo*, guardarlo fuera del teléfono, *Actualizar mis datos*. Comprobar que la lista muestra los mismos activos con sus miniaturas, que las fotos y audios abren y que el borrador pendiente (si había) sigue.
2. En **Proyectos**: renombrar "Proyecto 1", poner tu código de valuador. Crear un segundo proyecto: su lista de activos, edificios y departamentos debe estar vacía. Volver al primero: todo sigue, y *Nuevo activo* recuerda el último edificio/piso/departamento de ese proyecto.
3. El nombre del proyecto activo se ve siempre arriba; tocarlo abre Proyectos.
4. *Compartir paquete* → enviarlo por WhatsApp a otro teléfono → *Importar paquete de proyecto* → pide el código de valuador → aparecen los mismos edificios.
5. Archivar el proyecto activo: la app pide elegir otro; reactivarlo desde *Archivados*.
6. Exportar ZIP: el nombre incluye el proyecto y solo trae activos de ese proyecto.
7. Modo avión: crear un proyecto y un activo sin conexión.

## Pruebas manuales — v0.3 F1 (captura rápida)

1. **Nuevo activo** → Edificio → *+ Nuevo edificio* → crear "B14 Taller" sin salir. Piso, departamento.
2. **🔎 Placa** y **📷 Foto** con la cámara del sistema: la placa debe verse nítida con zoom en el visor (marca la otra como *General*).
3. Grabar voz, **Pausa**, hablar (no debe grabarse), **Seguir**, **Terminar**; reproducir.
4. **Guardar y nuevo**: se ve el ID en verde a pantalla completa, vibra, y arriba queda "Anterior guardado: B14-XX-A001". El nuevo activo conserva edificio/piso/departamento.
5. En la franja, **Copiar** → solo notas → cambiar el departamento → guardar: nuevo ID, chip "copia" en la lista.
6. Cambiar el edificio de un activo ya guardado (no exportado): su ID cambia al del edificio nuevo.
7. Ajustes → Cámara → **Cámara rápida**: tomar 5 fotos seguidas sin salir; probar *Placa* y la linterna; comparar nitidez de una placa contra la cámara del sistema. **Anotar resultado en S21 y en iPhone.**
8. Ajustes → Pantalla → **Modo sol**: probar al sol, con guantes.
9. Lista: filtros *Sin foto* / *Copias*, búsqueda por "A001".
10. Exportar: el ZIP trae `activos/B14-XX-A001_…/foto_01_placa.jpg` y `display_id` en `activos.csv`. Revisar si el audio sale `.m4a` o `.webm` en el S21.

## Pruebas manuales — v0.3 F2 (edificios)

1. Edificios: ver contadores Pendientes / En proceso / Inspeccionados y tocarlos para filtrar.
2. Abrir un edificio: llenar Ocupación, Año (`1960-1990`), Niveles, Altura en m (ver conversión a ft), un área con operación en m² (`12*95.5`), Muros con *Otro valor* (debe aparecer luego en otro edificio), HVAC categoría → tipo, Sí/No de servicios.
3. Sin foto, *Marcar inspeccionado* está desactivado. Tomar 1 foto → marcar → revisa la lista de campos vacíos → *Inspeccionado*.
4. Grabar una nota de voz describiendo el edificio.
5. Cerrar la app a mitad de la captura y reabrir: nada se pierde.
6. Exportar (Todos): el ZIP trae `edificios/B1/edificio.json` y la foto; abrir `edificios.csv` en Excel y comparar columnas con la plantilla original.
7. Usar el formulario con guantes y al sol (modo sol): ¿los botones de lista y Sí/No son cómodos?

## Pruebas manuales — v0.3 F3 (plantilla e importación)

1. Edificios → *Plantilla vacía*: abrirla en Excel (PC y móvil): listas desplegables, HVAC Type cambia según la categoría, encabezados con unidades.
2. Copiar y pegar 5 filas del archivo fuente a la plantilla → guardar → *Importar Excel* → revisar vista previa → importar.
3. Importar directamente *Allison Brugge.xlsx*: 13 edificios; aviso de "SPACE HEATERS, WITH FAN" fuera de lista (filas 2, 3, 12).
4. Capturar algo en campo en un edificio y reimportar: con "completar campos vacíos" lo capturado no cambia.
5. Probar un archivo con un código repetido y una fila sin código: los errores deben indicar la fila.
6. *Edificios a Excel* → abrir en Excel → reimportar sin cambios: "0 nuevos, 0 se actualizan".

## Pruebas manuales — v0.3 F4 (exportación para IA)

1. Exportar → *Todo el proyecto*: revisar el aviso previo (sin foto / sin nota / sin placa) y tocar un enlace: abre la lista filtrada.
2. Descargar el ZIP y abrirlo en la PC: carpetas por edificio y activo, nombres con el ID, `README_IA.md`, `indice.json`, CSV abren en Excel con acentos.
3. Darle el ZIP a la IA (p. ej. Claude) con la instrucción "procesa este levantamiento según README_IA.md" y revisar que identifique placas y copias.
4. Editar un activo y borrar otro ya exportado → *Solo lo nuevo o editado*: el ZIP trae solo el editado y `deleted` con el borrado.
5. Elegir *20 MB — correo* con muchas fotos: varias partes `parte1deN…`; cada edificio completo en una parte.
6. Android: *Descargar* y adjuntar desde WhatsApp (Documento → Descargas). iPhone: *Compartir* directo.

## Pruebas manuales — v0.3 F5 (reporte PDF)

1. Exportar → *📄 Compartir reporte* → elegir WhatsApp (Android y iPhone): llega un PDF que se abre bien en el teléfono del destinatario.
2. Revisar acentos y ñ (departamentos, nombres), tablas que pasan de página con encabezado repetido, número de página.
3. Edificios → *📄 Reporte*: mismo PDF.
4. En modo avión: el reporte se genera igual (se descarga o comparte cuando haya señal).

## Pruebas manuales — v0.3 F6 (pulido, temas, proyecto de prueba)

1. Instalar en un teléfono **sin la app**: al abrir aparece "Proyecto Test" (DEMO) con datos y fotos. Recorrer Inicio, un activo (ver la placa con zoom), Edificios, Exportar y el reporte PDF.
2. Proyectos → *Borrar proyecto de prueba* → crear el proyecto real. *Cargar proyecto de prueba* lo vuelve a crear.
3. Botón de tema (arriba a la derecha): Automático → Claro → Oscuro → Sol. Revisar legibilidad al sol y de noche.
4. Proyectos → *Respaldo* de un proyecto → restaurarlo en otro teléfono.
5. Registrar 25 activos sin exportar: debe aparecer el recordatorio en Inicio.
6. Teléfono que ya tenía la app (v0.3.5): actualizar → no debe aparecer el proyecto de prueba automáticamente.
