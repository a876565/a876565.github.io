from bs4 import BeautifulSoup
import json

with open("divcards.html",encoding='utf-8') as f:
    soup=BeautifulSoup(f.read(),'lxml')

divcards=soup.select('.DivinationCard')
#print(divcards[2].parent.parent)
card_db={}
for d in divcards:
    #get card name
    s:str=d.attrs['href']  #type:ignore
    s=s[s.rfind('/')+1:]
    s=s.replace('_',' ')
    if d.parent is None:
        print(f'Error parsing {s}')
        continue

    #get prop(stack size) and explicit(rewards)
    prop= d.parent.select_one('.property')
    explicit = d.parent.select_one('.explicitMod')
    if prop is None:
        continue
    if explicit is None:
        print(f'Error not found explicit for {s}')
        continue

    if s not in card_db:
        card_db[s]={
            'name':s,
            'type':'card',
            'stacks':prop.text,
            'brief':f'{explicit}',
        }


with open('poedb/cards.json','w') as f:
    f.write(json.dumps(list(card_db.values()),indent=2))