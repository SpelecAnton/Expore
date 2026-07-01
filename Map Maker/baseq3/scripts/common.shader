textures/common/clip
{
    qer_trans 0.40
    surfaceparm trans
    surfaceparm nolightmap
    surfaceparm nomarks
    surfaceparm playerclip
    surfaceparm monsterclip
}

// ── Video surface (emissive) ──────────────────────────────────────────────────
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