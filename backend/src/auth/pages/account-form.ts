import { BuyerProfileDto, SellerProfileDto, TypeOfUser } from '../auth.dto';

export function accountForms(account: { user: { roles: TypeOfUser[] }; buyerProfile: BuyerProfileDto; sellerProfile: SellerProfileDto }) {
    const form = (role: TypeOfUser, elements: object[]) => ({
        showTitle: false, showQuestionNumbers: 'off', widthMode: 'responsive',
        completeText: account.user.roles.includes(role) ? 'Save profile' : `Enable ${role} role`, elements,
    });
    return {
        buyer: { data: account.buyerProfile, form: form(TypeOfUser.Buyer, [
            { type: 'comment', name: 'deliveryAddress', title: 'Delivery address (optional)', maxLength: 500 },
        ]) },
        seller: { data: account.sellerProfile, form: form(TypeOfUser.Seller, [
            { type: 'text', name: 'companyName', title: 'Company name (optional)', maxLength: 160 },
            { type: 'comment', name: 'businessAddress', title: 'Business address (optional)', maxLength: 500 },
            { type: 'text', name: 'vatNumber', title: 'VAT number (optional)', maxLength: 40 },
        ]) },
    };
}
