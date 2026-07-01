

textures/lights/light_sky
{
    surfaceparm sky
    surfaceparm nomarks
    surfaceparm nolightmap

    q3map_sun 0.95 0.99 0.84  300  215  35
    //        R   G    B    int  yaw  pitch
    //
    // yaw   = 0°–360° (0=north/+X, 90=east, 180=south, 270=west)
    // pitch = 0°–90°  (0=horizon, 90=straight down = overhead)
    // int   = intensity, typically 100–500

    q3map_skylight 50 2
    // lower values = sharper / higher values = cloudy  (30-150 recommended)
    // number of samples   higher values = better quality

    skyparms textures/lights/light_sky 512 -
}


textures/light/monitor
{
    q3map_surfacelight 32000  // intensity
    q3map_lightsubdivide 16   // lower number = higher quality
    q3map_lightimage textures/cstrike/dust/FIFTIES 

    {
        map textures/light/monitor
        rgbGen texture
    }

    {
        map $lightmap
        blendFunc filter
        rgbGen identity
    }
}