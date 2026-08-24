# Запрос разработчику BatchRender: camera focal handoff

Ниже готовый текст, который можно отправить разработчику вместе с файлом `rh-camera-handoff.patch`.

---

Нужно добавить в BatchRender поддержку явного focal length override для камеры из JSON job.

## Зачем

Fabric и Shadow рендерятся в разных процессах Unreal, потому что Fabric использует Substrate, а перед Shadow Substrate необходимо отключить. Fit должен выполняться только один раз на Fabric (`36×36`). Shadow использует широкий sensor `108×36`, но обязан повторно применить точные Fabric camera location, rotation и focal length с `fit: none`. Сейчас `FCamera` умеет override только location/rotation, поэтому focal между процессами передать нельзя и Shadow повторно делает fit под широкий sensor, из-за чего слои не совпадают.

Плагин уже отправляет рассчитанное состояние через событие `sequence_camera_data`, включая:

- `cameraLocation`;
- `cameraRotation`;
- `FocalLength`;
- `SensorWidth` / `SensorHeight`;
- aperture и perspective flag.

Не хватает обратного входа для `FocalLength`.

## Нужный JSON API

```json
{
  "name": "F",
  "fit": "none",
  "Camera": {
    "OverrideLocation": true,
    "Location": { "X": -13.336, "Y": 1650, "Z": 120 },
    "OverrideRotation": true,
    "Rotation": { "Pitch": -3, "Yaw": -90, "Roll": 0 },
    "OverrideFocalLength": true,
    "FocalLength": 133.968018
  },
  "LayerResolutions": [
    {
      "Name": "Shadow",
      "Resolution": { "X": 15000, "Y": 5000 },
      "SensorSize": { "X": 108, "Y": 36 }
    }
  ]
}
```

Ожидаемое поведение: Shadow не выполняет fit, применяет переданные transform/focal, но рендерится с собственным `108×36`. Так как высота sensor и высота output совпадают с Fabric, центральные `5000×5000` пикселей должны совмещаться с Fabric pixel-to-pixel, а широкий Shadow добавляет область слева и справа.

## Предлагаемая реализация

Лучший upstream-вариант:

1. Добавить в `FCamera` поля:
   - `bool OverrideFocalLength = false`;
   - `float FocalLength = 0.0f`.
2. В `BP_BatchRenderManager` рядом с location/rotation напрямую применять focal к sequence camera, когда override включён.
3. Добавить стабильный capability marker `CameraFocalHandoffVersion = 1`, чтобы внешний контроллер мог определить поддержку после обновления плагина.
4. Сохранить обратную совместимость: старые jobs без новых полей должны работать без изменений.

Приложенный patch — рабочий локальный вариант без изменения Blueprint asset. Он хранит focal overrides в очереди по `sequenceName` во время `ParseJobFromJson` и применяет их в `GetSequenceCameraDefaults`. Если есть возможность обновить Blueprint, прямое применение из `FCamera` предпочтительнее этой очереди.

## Acceptance criteria

1. Старые JSON jobs рендерятся без изменения поведения.
2. При `OverrideFocalLength: true`, `FocalLength: 133.968018`, `fit: none` sequence camera перед рендером получает ровно `133.968018`.
3. `SensorSize 108×36` не изменяет переданный focal и не запускает новый fit.
4. Несколько tasks, использующих одинаковые sequence names, получают собственные focal values без утечки между tasks.
5. При `OverrideFocalLength: false` или отсутствующем поле используется прежняя логика.
6. `sequence_camera_data` после применения возвращает то же focal value.

Файлы для передачи:

- `rh-camera-handoff.patch` — точный минимальный C++ diff;
- этот документ — описание API и критериев приёмки.

