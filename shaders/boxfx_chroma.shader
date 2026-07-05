// Crop-aware rounded corners + border with ANTI-ALIASING.
// Corner pixels blend smoothly into chroma key color (magenta) so the downstream
// Color Key filter produces smooth transparency instead of jagged edges.
uniform int corner_radius;
uniform int border_width;
uniform float4 border_color;
uniform float canvas_w;
uniform float canvas_h;
uniform float crop_left;
uniform float crop_right;
uniform float crop_top;
uniform float crop_bottom;

#define KEY_COLOR float4(1.0, 0.0, 1.0, 1.0)
#define AA 2.0  // anti-alias width in pixels

float4 mainImage(VertData v_in) : TARGET
{
    float4 src = image.Sample(textureSampler, v_in.uv);
    float2 px = v_in.uv * float2(canvas_w, canvas_h);

    float vl = crop_left * canvas_w;
    float vr = (1.0 - crop_right) * canvas_w;
    float vt = crop_top * canvas_h;
    float vb = (1.0 - crop_bottom) * canvas_h;

    float dx = min(px.x - vl, vr - px.x);
    float dy = min(px.y - vt, vb - px.y);

    // Smooth mask: 1.0 well inside, 0.0 well outside, gradient at edges
    float maskX = smoothstep(0.0, AA, dx);
    float maskY = smoothstep(0.0, AA, dy);
    float edgeMask = min(maskX, maskY);

    float cr = (float)corner_radius;

    // Rounded corner mask: subtract the corner cutout
    if (cr > 0.5 && dx < cr + AA && dy < cr + AA) {
        float dist = distance(float2(dx, dy), float2(cr, cr));
        float cornerMask = 1.0 - smoothstep(cr - AA, cr + AA, dist);
        edgeMask = min(edgeMask, cornerMask);
    }

    // Blend source with key color based on mask (smooth AA edge)
    float4 result = lerp(KEY_COLOR, src, edgeMask);

    // Border: draw on straight edges AND corner edges
    float bw = (float)border_width;
    if (bw > 0.5) {
        if (cr > 0.5 && dx < cr && dy < cr) {
            // Corner border: within bw inside the rounded arc
            float dist = distance(float2(dx, dy), float2(cr, cr));
            if (dist > cr - bw && dist <= cr) result = border_color;
        } else {
            // Straight edge border: within bw of nearest edge
            if (dx < bw || dy < bw) result = border_color;
        }
    }

    return result;
}
