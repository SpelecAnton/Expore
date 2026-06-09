textures/common/clip
{
    qer_trans 0.40
    surfaceparm trans
    surfaceparm nolightmap
    surfaceparm nomarks
    surfaceparm playerclip
    surfaceparm monsterclip
}

textures/lights/1k/*
{
    q3map_surfacelight 1000
    q3map_lightsubdivide 64
    q3map_lightImage $whiteimage
    {
        map $lightmap
        rgbGen identity
    }
    {
        map textures/lights/*
        blendFunc GL_DST_COLOR GL_ZERO
        rgbGen identity
    }
}

textures/lights/2k/*
{
    q3map_surfacelight 2000
    q3map_lightsubdivide 64
    q3map_lightImage $whiteimage
    {
        map $lightmap
        rgbGen identity
    }
    {
        map textures/lights/*
        blendFunc GL_DST_COLOR GL_ZERO
        rgbGen identity
    }
}

textures/lights/5k/*
{
    q3map_surfacelight 5000
    q3map_lightsubdivide 64
    q3map_lightImage $whiteimage
    {
        map $lightmap
        rgbGen identity
    }
    {
        map textures/lights/*
        blendFunc GL_DST_COLOR GL_ZERO
        rgbGen identity
    }
}

textures/video
{
    q3map_surfacelight 1000
    q3map_lightsubdivide 64
    {
        map $lightmap
        rgbGen identity
    }
    {
        map textures/video.png
        blendFunc GL_DST_COLOR GL_ZERO
        rgbGen identity
    }
}