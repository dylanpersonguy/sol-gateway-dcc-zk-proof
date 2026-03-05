#!/usr/bin/env python3
"""Verify the correct G2 coordinate interpretation for snarkjs points"""
P = 21888242871839275222246405745257275088696311157297823662689037894645226208583
inv82 = pow(82, P-2, P)
b_c0 = (27*inv82) % P
b_c1 = (P - (3*inv82)%P) % P

def fq2_mul(a,b):
    return ((a[0]*b[0]-a[1]*b[1])%P, (a[0]*b[1]+a[1]*b[0])%P)
def fq2_add(a,b):
    return ((a[0]+b[0])%P, (a[1]+b[1])%P)

# vk_beta_2 from snarkjs: x=[x0,x1], y=[y0,y1]
x0=6375614351688725206403948262868962793625744043794305715222011528459656738731
x1=4252822878758300859123897981450591353533073413197771768651442665752259397132
y0=10505242626370262277552901082094356697409835680220590971873171140371331206856
y1=21847035105528745403288232691147584728191162732299865338377159692350059136679

# Test interpretation 1: x0=real(c0), x1=imaginary(c1)
x = (x0, x1); y = (y0, y1)
x2 = fq2_mul(x,x); x3 = fq2_mul(x2,x)
rhs = fq2_add(x3, (b_c0, b_c1))
lhs = fq2_mul(y,y)
print(f'Interpretation 1 (x0=real, x1=imag): on curve = {lhs == rhs}')

# Test interpretation 2: x0=imaginary(c1), x1=real(c0)
x = (x1, x0); y = (y1, y0)
x2 = fq2_mul(x,x); x3 = fq2_mul(x2,x)
rhs = fq2_add(x3, (b_c0, b_c1))
lhs = fq2_mul(y,y)
print(f'Interpretation 2 (x0=imag, x1=real): on curve = {lhs == rhs}')
