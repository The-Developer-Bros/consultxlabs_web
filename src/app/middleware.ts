import {NextRequest, NextResponse} from 'next/server'
import prisma from '@/lib/prisma'

export async function middleware(req: NextRequest) {
    // const user = await prisma.user.findUnique({ where: { email: req.cookies.email } })
    // if (!user) {
    //     return NextResponse.redirect('/login')
    // } else if (!user.onboarded && req.nextUrl.pathname !== '/form/onboarding') {
    //     return NextResponse.redirect('/form/onboarding')
    // } else if (user.onboarded && req.nextUrl.pathname === '/form/onboarding') {
    //     return NextResponse.redirect('/')
    // }
    return NextResponse.next()
}



export default middleware